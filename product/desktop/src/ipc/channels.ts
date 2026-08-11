export const WINDOW_IPC_CHANNEL = "uclaw:window";
export const CLIENT_IPC_CHANNEL = "uclaw:client";
export const CLIENT_IPC_EVENT_CHANNEL = "uclaw:client-event";
export const WINDOW_MAXIMIZED_EVENT_CHANNEL = "uclaw:window-maximized";
export const ATTACHMENT_IPC_CHANNEL = "uclaw:attachments";
export const PROVIDER_IPC_CHANNEL = "uclaw:providers";
export const SKILL_IPC_CHANNEL = "uclaw:skills";
export const PLUGIN_IPC_CHANNEL = "uclaw:plugins";
export const CHANNEL_IPC_CHANNEL = "uclaw:managed-channels";
export const MCP_IPC_CHANNEL = "uclaw:mcp-servers";
export const SESSION_ADVANCED_IPC_CHANNEL = "uclaw:session-advanced";
export const USAGE_IPC_CHANNEL = "uclaw:usage";
export const DATA_IPC_CHANNEL = "uclaw:data";
export const DIAGNOSTICS_IPC_CHANNEL = "uclaw:diagnostics";
export const RELEASE_IPC_CHANNEL = "uclaw:release";

export const IPC_CHANNELS = Object.freeze([
  WINDOW_IPC_CHANNEL,
  CLIENT_IPC_CHANNEL,
  CLIENT_IPC_EVENT_CHANNEL,
  WINDOW_MAXIMIZED_EVENT_CHANNEL,
  ATTACHMENT_IPC_CHANNEL,
  PROVIDER_IPC_CHANNEL,
  SKILL_IPC_CHANNEL,
  PLUGIN_IPC_CHANNEL,
  CHANNEL_IPC_CHANNEL,
  MCP_IPC_CHANNEL,
  SESSION_ADVANCED_IPC_CHANNEL,
  USAGE_IPC_CHANNEL,
  DATA_IPC_CHANNEL,
  DIAGNOSTICS_IPC_CHANNEL,
  RELEASE_IPC_CHANNEL,
] as const);
