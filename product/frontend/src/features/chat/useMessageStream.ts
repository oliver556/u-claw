import type { ApprovalRequest, Message, MessageEvent, ToolCall } from "@uclaw/shared";
import { useCallback, useReducer } from "react";

export type RunTerminal = "final" | "aborted" | "error";

export interface StreamRun {
  runId: string;
  sessionId?: string;
  text: string;
  tools: ToolCall[];
  approvals: ApprovalRequest[];
  terminal?: RunTerminal;
  finalMessage?: Message;
  errorMessage?: string;
  completedAt?: string;
}

export interface StreamState {
  runs: Record<string, StreamRun>;
  order: string[];
}

export const initialStreamState: StreamState = { runs: {}, order: [] };

type StreamAction = MessageEvent | { type: "dismiss-approval"; approvalId: string };

export function messageEventReducer(state: StreamState, event: StreamAction): StreamState {
  if (event.type === "dismiss-approval") {
    return {
      ...state,
      runs: Object.fromEntries(Object.entries(state.runs).map(([runId, run]) => [runId, {
        ...run,
        approvals: run.approvals.filter((approval) => approval.id !== event.approvalId),
      }])),
    };
  }
  const current = state.runs[event.runId];
  const run: StreamRun = current ?? { runId: event.runId, text: "", tools: [], approvals: [] };
  if (run.terminal !== undefined) return state;

  let next = run;
  switch (event.type) {
    case "started":
      next = { ...run, sessionId: event.sessionId };
      break;
    case "delta":
      next = { ...run, text: event.mode === "replace" ? event.text : `${run.text}${event.text}` };
      break;
    case "tool":
      next = { ...run, tools: [...run.tools.filter((tool) => tool.id !== event.tool.id), event.tool] };
      break;
    case "approval":
      next = { ...run, approvals: [...run.approvals.filter((approval) => approval.id !== event.approval.id), event.approval] };
      break;
    case "final":
      next = { ...run, terminal: "final", finalMessage: event.message, completedAt: new Date().toISOString() };
      break;
    case "aborted":
      next = { ...run, terminal: "aborted", errorMessage: event.reason ?? "已停止", completedAt: new Date().toISOString() };
      break;
    case "error":
      next = { ...run, terminal: "error", errorMessage: event.error.message, completedAt: new Date().toISOString() };
      break;
  }

  return {
    runs: { ...state.runs, [event.runId]: next },
    order: current === undefined ? [...state.order, event.runId] : state.order,
  };
}

export function useMessageStream(onEvent?: (event: MessageEvent) => void) {
  const [state, dispatch] = useReducer(messageEventReducer, initialStreamState);

  const consume = useCallback(async (source: AsyncIterable<MessageEvent>, consumeEvent?: (event: MessageEvent) => void) => {
    const iterator = source[Symbol.asyncIterator]();
    let runId: string | undefined;
    try {
      while (true) {
        const item = await iterator.next();
        if (item.done) {
          const failure = new Error("消息流在完成前中断");
          if (runId !== undefined) {
            const event: MessageEvent = {
              type: "error",
              runId,
              error: {
                code: "GATEWAY_DISCONNECTED",
                message: failure.message,
                retryable: true,
                recoveryActions: ["reconnect"],
                causeDetails: { operation: "chat.stream" },
              },
            };
            dispatch(event);
            onEvent?.(event);
            consumeEvent?.(event);
          }
          throw failure;
        }
        const event = item.value;
        runId = event.runId;
        dispatch(event);
        onEvent?.(event);
        consumeEvent?.(event);
        if (event.type === "final" || event.type === "aborted" || event.type === "error") return event;
      }
    } finally {
      await iterator.return?.();
    }
  }, [onEvent]);

  const dismissApproval = useCallback((approvalId: string) => {
    dispatch({ type: "dismiss-approval", approvalId });
  }, []);

  return { state, consume, dismissApproval };
}
