export const WINDOW_IPC_CHANNEL = "uclaw:window";
export const CLIENT_IPC_CHANNEL = "uclaw:client";
export const CLIENT_IPC_EVENT_CHANNEL = "uclaw:client-event";
export const WINDOW_MAXIMIZED_EVENT_CHANNEL = "uclaw:window-maximized";

export const IPC_CHANNELS = Object.freeze([
  WINDOW_IPC_CHANNEL,
  CLIENT_IPC_CHANNEL,
  CLIENT_IPC_EVENT_CHANNEL,
  WINDOW_MAXIMIZED_EVENT_CHANNEL,
] as const);
