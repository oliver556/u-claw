import { createServer } from "node:net";

export const GATEWAY_PORT_MIN = 18789;
export const GATEWAY_PORT_MAX = 18799;

export type PortProbe = (port: number, host: string) => Promise<boolean>;

export interface SelectGatewayPortOptions {
  probe?: PortProbe;
  host?: string;
  excludedPorts?: readonly number[];
}

export const probePort: PortProbe = (port, host) => new Promise((resolve) => {
  const server = createServer();
  server.unref();
  server.once("error", () => resolve(false));
  server.listen({ port, host, exclusive: true }, () => {
    server.close(() => resolve(true));
  });
});

export async function selectGatewayPort({
  probe = probePort,
  host = "127.0.0.1",
  excludedPorts = [],
}: SelectGatewayPortOptions = {}): Promise<number> {
  const excluded = new Set(excludedPorts);
  for (let port = GATEWAY_PORT_MIN; port <= GATEWAY_PORT_MAX; port += 1) {
    if (excluded.has(port)) continue;
    if (await probe(port, host)) return port;
  }
  throw new Error(`No available gateway port in ${GATEWAY_PORT_MIN}-${GATEWAY_PORT_MAX}.`);
}
