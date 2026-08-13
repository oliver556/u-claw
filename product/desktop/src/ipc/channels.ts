export const WINDOW_IPC_CHANNEL = "uclaw:window";
export const CLIENT_IPC_CHANNEL = "uclaw:client";
export const CLIENT_IPC_EVENT_CHANNEL = "uclaw:client-event";
export const WINDOW_MAXIMIZED_EVENT_CHANNEL = "uclaw:window-maximized";
export const ATTACHMENT_IPC_CHANNEL = "uclaw:attachments";
export const CHAT_QUEUE_IPC_CHANNEL = "uclaw:chat-queue";
export const PROVIDER_IPC_CHANNEL = "uclaw:providers";
export const SKILL_IPC_CHANNEL = "uclaw:skills";
export const PLUGIN_IPC_CHANNEL = "uclaw:plugins";
export const CHANNEL_IPC_CHANNEL = "uclaw:managed-channels";
export const MCP_IPC_CHANNEL = "uclaw:mcp-servers";
export const SESSION_ADVANCED_IPC_CHANNEL = "uclaw:session-advanced";
export const USAGE_IPC_CHANNEL = "uclaw:usage";
export const AUTOMATION_IPC_CHANNEL = "uclaw:automation";
export const TASK_ARTIFACT_IPC_CHANNEL = "uclaw:task-artifacts";
export const TASK_ARTIFACT_EVENT_CHANNEL = "uclaw:task-artifact-event";
export const SYSTEM_NODE_IPC_CHANNEL = "uclaw:system-node";
export const SYSTEM_NODE_IPC_EVENT_CHANNEL = "uclaw:system-node-event";
export const SYSTEM_VOICE_IPC_CHANNEL = "uclaw:system-voice";
export const PRODUCT_SERVICES_IPC_CHANNEL = "uclaw:product-services";
export const DATA_IPC_CHANNEL = "uclaw:data";
export const DIAGNOSTICS_IPC_CHANNEL = "uclaw:diagnostics";
export const RELEASE_IPC_CHANNEL = "uclaw:release";
export const IMAGE_OPERATION_IPC_CHANNEL = "uclaw:image-operation";

export const IPC_CHANNELS = Object.freeze([
  WINDOW_IPC_CHANNEL,
  CLIENT_IPC_CHANNEL,
  CLIENT_IPC_EVENT_CHANNEL,
  WINDOW_MAXIMIZED_EVENT_CHANNEL,
  ATTACHMENT_IPC_CHANNEL,
  CHAT_QUEUE_IPC_CHANNEL,
  PROVIDER_IPC_CHANNEL,
  SKILL_IPC_CHANNEL,
  PLUGIN_IPC_CHANNEL,
  CHANNEL_IPC_CHANNEL,
  MCP_IPC_CHANNEL,
  SESSION_ADVANCED_IPC_CHANNEL,
  USAGE_IPC_CHANNEL,
  AUTOMATION_IPC_CHANNEL,
  TASK_ARTIFACT_IPC_CHANNEL,
  TASK_ARTIFACT_EVENT_CHANNEL,
  SYSTEM_NODE_IPC_CHANNEL,
  SYSTEM_NODE_IPC_EVENT_CHANNEL,
  SYSTEM_VOICE_IPC_CHANNEL,
  PRODUCT_SERVICES_IPC_CHANNEL,
  DATA_IPC_CHANNEL,
  DIAGNOSTICS_IPC_CHANNEL,
  RELEASE_IPC_CHANNEL,
  IMAGE_OPERATION_IPC_CHANNEL,
] as const);
