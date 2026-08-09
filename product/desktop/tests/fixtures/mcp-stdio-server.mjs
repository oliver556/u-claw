import readline from "node:readline";

const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "notifications/initialized") return;
  const result = request.method === "initialize"
    ? { protocolVersion: "2025-06-18", serverInfo: { name: "stdio-fixture", version: "1.0.0" }, capabilities: { tools: {}, resources: {} } }
    : request.method === "tools/list"
      ? { tools: [{ name: "fixture_search", description: "fixture" }] }
      : { resources: [{ uri: "fixture://docs", name: "Fixture docs" }] };
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
});
