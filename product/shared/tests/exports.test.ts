import { describe, expectTypeOf, it } from "vitest";

import type {
  ApprovalService,
  CapabilitySet,
  ChatService,
  GatewayService,
  MessageEvent,
  SessionService,
  UClawClient,
  ExecApprovalRef,
  PluginApprovalRef,
} from "../src/index.js";
import {
  ExecApprovalRequestSchema,
  PluginApprovalRequestSchema,
  toApprovalRef,
} from "../src/index.js";

describe("public type exports", () => {
  it("exports client service contracts from the package entrypoint", () => {
    expectTypeOf<UClawClient["gateway"]>().toEqualTypeOf<GatewayService>();
    expectTypeOf<UClawClient["sessions"]>().toEqualTypeOf<SessionService>();
    expectTypeOf<UClawClient["chat"]>().toEqualTypeOf<ChatService>();
    expectTypeOf<UClawClient["approvals"]>().toEqualTypeOf<ApprovalService>();
    expectTypeOf<CapabilitySet["protocolVersion"]>().toEqualTypeOf<4>();
    expectTypeOf<ReturnType<ChatService["send"]>>().toEqualTypeOf<AsyncIterable<MessageEvent>>();
    expectTypeOf<NonNullable<SessionService["rename"]>>().toBeFunction();
  });

  it("uses family-specific approval service inputs", () => {
    expectTypeOf<Parameters<ApprovalService["resolveExec"]>[0]>().toMatchTypeOf<{ ref: { family: "exec" } }>();
    expectTypeOf<Parameters<ApprovalService["resolvePlugin"]>[0]>().toMatchTypeOf<{ ref: { family: "plugin" } }>();
  });

  it("preserves narrowed approval ref types through the helper overloads", () => {
    const shared = {
      id: "approval-1",
      title: "Approval",
      description: "Approve operation",
      risk: "low",
      permissions: [{ kind: "other" as const, scope: "operation", description: "Approve" }],
      choices: ["deny" as const],
      status: "pending" as const,
    };
    const exec = ExecApprovalRequestSchema.parse({ ...shared, family: "exec", subject: { kind: "operation", id: "operation-1" } });
    const plugin = PluginApprovalRequestSchema.parse({ ...shared, family: "plugin", subject: { kind: "plugin", id: "plugin-1" } });
    const execRef = toApprovalRef(exec);
    const pluginRef = toApprovalRef(plugin);
    const execInput: Parameters<ApprovalService["resolveExec"]>[0] = { ref: execRef, decision: "deny" };

    expectTypeOf(execRef).toEqualTypeOf<ExecApprovalRef>();
    expectTypeOf(pluginRef).toEqualTypeOf<PluginApprovalRef>();
    expectTypeOf(execInput.ref).toEqualTypeOf<ExecApprovalRef>();
  });
});
