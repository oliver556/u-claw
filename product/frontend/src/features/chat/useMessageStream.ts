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
}

export interface StreamState {
  runs: Record<string, StreamRun>;
  order: string[];
}

export const initialStreamState: StreamState = { runs: {}, order: [] };

export function messageEventReducer(state: StreamState, event: MessageEvent): StreamState {
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
      next = { ...run, terminal: "final", finalMessage: event.message };
      break;
    case "aborted":
      next = { ...run, terminal: "aborted", errorMessage: event.reason ?? "已停止" };
      break;
    case "error":
      next = { ...run, terminal: "error", errorMessage: event.error.message };
      break;
  }

  return {
    runs: { ...state.runs, [event.runId]: next },
    order: current === undefined ? [...state.order, event.runId] : state.order,
  };
}

export function useMessageStream(onEvent?: (event: MessageEvent) => void) {
  const [state, dispatch] = useReducer(messageEventReducer, initialStreamState);

  const consume = useCallback(async (source: AsyncIterable<MessageEvent>) => {
    let terminal: MessageEvent | undefined;
    for await (const event of source) {
      dispatch(event);
      onEvent?.(event);
      if (event.type === "final" || event.type === "aborted" || event.type === "error") terminal = event;
    }
    return terminal;
  }, [onEvent]);

  return { state, consume };
}
