import { createHash } from "node:crypto";

import { McpServerConfigEntrySchema, type McpServerConfigEntry } from "@uclaw/shared";

export interface McpStdioPolicyAssessment {
  allowed: boolean;
  executableId: "node" | "npx" | "python" | "uvx";
  confirmationRequired: boolean;
  fingerprint: string;
  warning?: string;
}

const forbiddenFlags = new Set(["-c", "-e", "--eval", "--import", "--require"]);
const shellSyntax = /[;&|`$<>\r\n]/u;
const pathTraversal = /(^|[\\/])\.\.([\\/]|$)/u;
const absolutePath = /^(?:[A-Za-z]:[\\/]|[\\/])/u;

export function assessMcpStdioPolicy(value: unknown): McpStdioPolicyAssessment {
  const server = McpServerConfigEntrySchema.parse(value) as McpServerConfigEntry;
  if (server.transport !== "stdio") throw new Error("MCP stdio policy requires a stdio server.");
  const envKeys = Object.keys(server.env);
  const unsafeArgument = server.args.some((argument) =>
    forbiddenFlags.has(argument) || shellSyntax.test(argument) || pathTraversal.test(argument) || absolutePath.test(argument));
  const unsafeEnvironment = envKeys.some((key) => !key.startsWith("MCP_"));
  const allowed = !unsafeArgument && !unsafeEnvironment;
  const confirmationRequired = allowed && (server.executableId === "npx" || server.executableId === "uvx" || envKeys.length > 0);
  const fingerprint = `sha256:${createHash("sha256").update(JSON.stringify({
    executableId: server.executableId,
    args: server.args,
    env: Object.entries(server.env).sort(([left], [right]) => left.localeCompare(right)),
  })).digest("hex")}`;
  return {
    allowed,
    executableId: server.executableId,
    confirmationRequired,
    fingerprint,
    ...(!allowed ? { warning: "stdio 配置被安全策略拒绝。" } : confirmationRequired ? { warning: "该 stdio 配置会执行包或注入环境变量，需要确认风险。" } : {}),
  };
}
