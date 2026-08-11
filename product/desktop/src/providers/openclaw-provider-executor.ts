import type { MessageEvent, ProviderConfigEntry, ProviderNetworkSettings, SendMessageInput } from "@uclaw/shared";

interface OpenClawProviderClient {
  models: { selectForSession(sessionId: string, modelId: string): Promise<void> };
  chat: { send(input: SendMessageInput, signal?: AbortSignal): AsyncIterable<MessageEvent> };
}

export function createOpenClawProviderExecutor(client: OpenClawProviderClient) {
  return async (
    input: SendMessageInput,
    provider: ProviderConfigEntry,
    signal?: AbortSignal,
    _network?: ProviderNetworkSettings,
  ): Promise<AsyncIterable<MessageEvent>> => {
    await client.models.selectForSession(input.sessionId, `${provider.id}/${provider.model}`);
    return client.chat.send(input, signal);
  };
}
