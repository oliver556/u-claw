export interface GatewayMediaWebRequest {
  onBeforeSendHeaders(
    filter: { urls: string[] },
    listener: ((
      details: { url: string; requestHeaders: Record<string, string> },
      callback: (result: { requestHeaders: Record<string, string> }) => void,
    ) => void) | null,
  ): void;
}

const MEDIA_PATH = /^\/api\/chat\/media\/outgoing\/([^/]+)\/[0-9a-f-]+\/(?:full|preview)$/iu;

export function installGatewayMediaRequestAuth(webRequest: GatewayMediaWebRequest, port: number, token: string): () => void {
  const filter = { urls: [
    `http://127.0.0.1:${port}/api/chat/media/outgoing/*`,
    `http://127.0.0.1:${port}/__openclaw__/assistant-media*`,
  ] };
  const listener = (details: { url: string; requestHeaders: Record<string, string> }, callback: (result: { requestHeaders: Record<string, string> }) => void) => {
    const url = new URL(details.url);
    if (url.pathname === "/__openclaw__/assistant-media") {
      callback({ requestHeaders: { ...details.requestHeaders, Authorization: `Bearer ${token}` } });
      return;
    }
    const encodedSessionKey = MEDIA_PATH.exec(url.pathname)?.[1];
    if (encodedSessionKey === undefined) {
      callback({ requestHeaders: details.requestHeaders });
      return;
    }
    let sessionKey: string;
    try {
      sessionKey = decodeURIComponent(encodedSessionKey);
      const normalize = (value: string) => value.replace(/%[0-9a-f]{2}/giu, (escape) => escape.toUpperCase());
      if (normalize(encodeURIComponent(sessionKey)) !== normalize(encodedSessionKey)) throw new URIError("Non-canonical encoding");
    } catch {
      callback({ requestHeaders: details.requestHeaders });
      return;
    }
    callback({ requestHeaders: {
      ...details.requestHeaders,
      Authorization: `Bearer ${token}`,
      "x-openclaw-requester-session-key": sessionKey,
    } });
  };
  webRequest.onBeforeSendHeaders(filter, listener);
  return () => webRequest.onBeforeSendHeaders(filter, null);
}
