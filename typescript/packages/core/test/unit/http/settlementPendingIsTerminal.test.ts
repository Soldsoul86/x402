/**
 * `settlement_pending` reaches the payer as the same 402 a terminal failure does.
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
 * branches on `settleResponse.success` alone
 * (`x402HTTPResourceServer.ts:847`) — `errorReason` is read only to build a
 * message — and `buildSettlementFailureResponse` returns `status: 402` for
 * every unsuccessful settle (`:1059`). The payer is handed the same
 * instruction it gets for `insufficient_funds`: present payment again. A
 * client that re-signs produces a different payload, so the pending-settlement
 * store has no entry to match it on, and a second authorization is obtained
 * while the first may still settle.
 *
 * The assertion below states only that the two must be distinguishable. What a
 * resource server should return in place of the 402 is a separate question, so
 * nothing here presumes an answer to it.
 *
 * Marked `test.fails` so the suite stays green on today's behaviour and turns
 * red the day the branch is changed — at which point this annotation comes off
 * and the assertion stands on its own.
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

  /** Drives one settlement to the given outcome and returns the HTTP status the payer sees. */
  const statusFor = async (errorReason: string, transaction: string): Promise<number> => {
    mockFacilitator.settle = async () => ({
      success: false,
      errorReason,
      transaction,
      network: NETWORK,
    });
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
    return result.response.status;
  };

  test.fails("is distinguishable from a terminal failure", async () => {
    // Non-terminal: broadcast, confirmation not yet established (§9 requires a
    // non-empty `transaction` alongside this code). Settles twice — the
    // automatic retry fires and comes back pending again.
    const pending = await statusFor("settlement_pending", "0xbroadcast");
    // Terminal: nothing moved, and re-presenting is the correct next step.
    const terminal = await statusFor("insufficient_funds", "");

    expect(pending).not.toBe(terminal);
  });
});
