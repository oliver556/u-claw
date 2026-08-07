import { describe, expectTypeOf, it } from "vitest";

import type {
  ApprovalService,
  CapabilitySet,
  ChatService,
  GatewayService,
  MessageEvent,
  SessionService,
  UClawClient,
} from "../src/index.js";

describe("public type exports", () => {
  it("exports client service contracts from the package entrypoint", () => {
    expectTypeOf<UClawClient["gateway"]>().toEqualTypeOf<GatewayService>();
    expectTypeOf<UClawClient["sessions"]>().toEqualTypeOf<SessionService>();
    expectTypeOf<UClawClient["chat"]>().toEqualTypeOf<ChatService>();
    expectTypeOf<UClawClient["approvals"]>().toEqualTypeOf<ApprovalService>();
    expectTypeOf<CapabilitySet["protocolVersion"]>().toEqualTypeOf<4>();
    expectTypeOf<ReturnType<ChatService["send"]>>().toEqualTypeOf<AsyncIterable<MessageEvent>>();
  });
});
