/**
 * `settlement_pending` reaches the payer as the re-present instruction.
 *
 * §9 defines `settlement_pending` as non-terminal: the caller reconciles on
 * chain before deciding whether to retry. The core already treats it that way
 * internally — `settlePayment` retries once on a pending outcome that carries a
 * broadcast hash (`x402ResourceServer.ts:1577`), and `PendingSettlementStore`
 * exists so a facilitator can reconcile against the hash it already broadcast
 * instead of broadcasting a second one.
 *
 * Both of those protections are keyed on the payment payload. Once the single
 * retry is exhausted and the outcome is still pending, `processSettlement`
 * branches on `settleResponse.success` alone (`x402HTTPResourceServer.ts:847`)
 * — `errorReason` is read only to build a message — and
 * `buildSettlementFailureResponse` returns `status: 402` for every unsuccessful
 * settle (`:1059`). A 402 is a payment challenge: a client that re-signs
 * produces a different payload, so the pending-settlement store has no entry to
 * match it on, and a second authorization is obtained while the first may still
 * settle.
 *
 * The claim is therefore not that the two outcomes are indistinguishable. It is
 * that a status-reading client is handed the re-pay instruction for an outcome
 * that may still settle. The assertions below are directional so they say which
 * side is wrong:
 *
 * - a terminal failure is 402, and that is correct — re-presenting is what an
 *   `insufficient_funds` payer should do;
 * - a pending outcome must not be 402.
 *
 * The terminal assertion is a plain `test` rather than part of the `test.fails`
 * case on purpose. `:1059` is a single `return` reached by all three failure
 * paths (`:856`, `:886`, `:903`), so the nearest edit for anyone fixing this is
 * to change that shared literal — which moves both outcomes together and would
 * pass silently inside the marker.
 *
 * More generally: a `test.fails` case cannot prove why it failed. Any failure in
 * its lifecycle satisfies it — an unrelated `expect`, a plain `Error`, even a
 * throwing `beforeEach` whose body never runs. So the marker carries only
 * "still broken", and everything load-bearing sits in a plain `test` beside it.
 *
 * What a resource server should return in place of the 402 is a separate
 * question (#3437), so nothing here presumes an answer to it.
 *
 * Review: the directional form and the settle-call assertion are @minia2auk's,
 * from review on this PR.
 */
import { describe, test, expect, beforeEach } from "vitest";

import { x402HTTPResourceServer } from "../../../src/http/x402HTTPResourceServer";
import { x402ResourceServer } from "../../../src/server/x402ResourceServer";
import {
  MockFacilitatorClient,
  MockSchemeNetworkServer,
  buildSupportedResponse,
  buildVerifyResponse,
  buildPaymentPayload,
  buildPaymentRequirements,
} from "../../mocks";
import { Network, Price } from "../../../src/types";

const NETWORK = "eip155:8453" as Network;

describe("settlement_pending reaching the payer", () => {
  let mockFacilitator: MockFacilitatorClient;
  let resourceServer: x402ResourceServer;

  beforeEach(async () => {
    mockFacilitator = new MockFacilitatorClient(
      buildSupportedResponse({ kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK }] }),
      buildVerifyResponse({ isValid: true }),
    );
    resourceServer = new x402ResourceServer(mockFacilitator);
    resourceServer.register(
      NETWORK,
      new MockSchemeNetworkServer("exact", {
        amount: "1000000",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        extra: {},
      }),
    );
    await resourceServer.initialize();
  });

  /**
   * Drives one settlement to the given outcome.
   *
   * @param errorReason - The `errorReason` the facilitator reports
   * @param transaction - The broadcast hash it reports alongside
   * @returns The HTTP status the payer sees, and how many times settle ran
   */
  const settle = async (
    errorReason: string,
    transaction: string,
  ): Promise<{ status: number; settleCalls: number }> => {
    let settleCalls = 0;
    mockFacilitator.settle = async () => {
      settleCalls++;
      return { success: false, errorReason, transaction, network: NETWORK };
    };
    const httpServer = new x402HTTPResourceServer(resourceServer, {
      "/api/test": {
        accepts: { scheme: "exact", payTo: "0xabc", price: "$1.00" as Price, network: NETWORK },
      },
    });
    const result = await httpServer.processSettlement(
      buildPaymentPayload(),
      buildPaymentRequirements({ scheme: "exact", network: NETWORK }),
    );
    expect(result.success).toBe(false);
    if (result.success) throw new Error("unreachable");
    return { status: result.response.status, settleCalls };
  };

  /** Nothing moved, so re-presenting is the correct next step. 402 says exactly that. */
  test("a terminal failure is answered with the re-present instruction", async () => {
    const terminal = await settle("insufficient_funds", "");

    expect(terminal.status).toBe(402);
    expect(terminal.settleCalls).toBe(1);
  });

  /**
   * The payer reaches the response only after the protection has already run:
   * the retry fires on the broadcast hash and comes back pending a second time.
   * Asserted here so the claim lives in the test rather than only in prose.
   */
  test("the pending outcome is retried once before the payer is answered", async () => {
    const pending = await settle("settlement_pending", "0xbroadcast");

    expect(pending.settleCalls).toBe(2);
  });

  /**
   * Marked `test.fails`: green on today's behaviour, red once the branch
   * changes, at which point the annotation comes off and the assertion stands
   * on its own.
   */
  test.fails("the pending outcome is not answered with the re-present instruction", async () => {
    const pending = await settle("settlement_pending", "0xbroadcast");

    expect(pending.status).not.toBe(402);
  });
});
