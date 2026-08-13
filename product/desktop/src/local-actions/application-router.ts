import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";

import { MessageEventSchema, type MessageEvent, type SendMessageInput } from "@uclaw/shared";
import { z } from "zod";

const ApplicationIndexSchema = z.object({
  schemaVersion: z.literal(1),
  applications: z.array(z.object({ name: z.string().min(1), path: z.string().min(1) }).strict()),
}).strict();

type Application = z.infer<typeof ApplicationIndexSchema>["applications"][number];
type Fallback = (input: SendMessageInput, signal?: AbortSignal) => AsyncIterable<MessageEvent> | Promise<AsyncIterable<MessageEvent>>;

export interface LocalApplicationRouterOptions {
  roots: readonly string[];
  cachePath: string;
  openPath(path: string): Promise<string>;
  inject(sessionId: string, message: string, label: "uclaw-local-user-v1" | "uclaw-local-result-v1", signal?: AbortSignal): Promise<void>;
  platform?: NodeJS.Platform;
}

const MAX_SCAN_DEPTH = 4;
const MAC_EXTENSION = ".app";
const WINDOWS_EXTENSIONS = new Set([".lnk", ".exe"]);
const LINUX_EXTENSION = ".desktop";

function normalizedName(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/(?:\.app|\.lnk|\.exe|\.desktop)$/u, "")
    .replace(/(?:office|软件|应用)$/u, "").replace(/[\s._-]+/gu, "");
}

function applicationName(path: string): string {
  return basename(path, extname(path));
}

function isApplication(path: string, directory: boolean, platform: NodeJS.Platform): boolean {
  const extension = extname(path).toLocaleLowerCase("en-US");
  if (platform === "darwin") return directory && extension === MAC_EXTENSION;
  if (platform === "win32") return !directory && WINDOWS_EXTENSIONS.has(extension);
  return !directory && extension === LINUX_EXTENSION;
}

function isWithin(root: string, target: string): boolean {
  const child = relative(root, target);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function requestedApplication(input: SendMessageInput): string | undefined {
  if (input.skillId !== undefined || input.blocks.length !== 1 || input.blocks[0]?.type !== "text") return undefined;
  const text = input.blocks[0].text.trim();
  const match = /^(?:(?:请|麻烦)(?:你)?\s*)?(?:帮我\s*)?(?:打开|启动|运行)\s*(?:一下\s*)?([^/\\，,；;：:\n]+?)(?:软件|应用)?[。.!！]?$/u.exec(text);
  if (!match) return undefined;
  const name = match[1]!.trim();
  if (name.length < 1 || name.length > 80 || /(?:然后|并且|同时|之后|里面|中|里|新建|创建|写|编辑|关闭)/u.test(name)) return undefined;
  return name;
}

async function atomicWrite(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export function defaultApplicationRoots(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform === "darwin") return ["/Applications", ...(env.HOME ? [join(env.HOME, "Applications")] : [])];
  if (platform === "win32") return [
    ...(env.APPDATA ? [join(env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs")] : []),
    ...(env.ProgramData ? [join(env.ProgramData, "Microsoft", "Windows", "Start Menu", "Programs")] : []),
  ];
  return ["/usr/share/applications", ...(env.HOME ? [join(env.HOME, ".local", "share", "applications")] : [])];
}

export function createLocalApplicationRouter(options: LocalApplicationRouterOptions) {
  const platform = options.platform ?? process.platform;
  let applications: Application[] | undefined;
  let refreshPromise: Promise<void> | undefined;

  const performRefresh = async (): Promise<void> => {
    const found = new Map<string, Application>();
    const scan = async (candidate: string, root: string, depth: number): Promise<void> => {
      if (depth > MAX_SCAN_DEPTH) return;
      let entries;
      try { entries = await readdir(candidate, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const path = join(candidate, entry.name);
        if (isApplication(path, entry.isDirectory(), platform)) {
          const key = normalizedName(entry.name);
          if (key && !found.has(key)) found.set(key, { name: applicationName(path), path });
        } else if (entry.isDirectory()) await scan(path, root, depth + 1);
      }
    };
    for (const candidate of options.roots) {
      try {
        const root = await realpath(candidate);
        await scan(root, root, 0);
      } catch { /* Missing optional application roots are normal. */ }
    }
    applications = [...found.values()].sort((left, right) => left.name.localeCompare(right.name));
    await atomicWrite(options.cachePath, { schemaVersion: 1, applications });
  };

  const refresh = (): Promise<void> => {
    if (refreshPromise !== undefined) return refreshPromise;
    refreshPromise = performRefresh().finally(() => { refreshPromise = undefined; });
    return refreshPromise;
  };

  const load = async (): Promise<Application[]> => {
    if (applications !== undefined) return applications;
    try {
      applications = ApplicationIndexSchema.parse(JSON.parse(await readFile(options.cachePath, "utf8"))).applications;
    } catch {
      await refresh();
    }
    return applications ?? [];
  };

  const validTarget = async (application: Application): Promise<boolean> => {
    try {
      const target = await realpath(application.path);
      const info = await lstat(target);
      const allowed = await Promise.all(options.roots.map(async (root) => {
        try { return isWithin(await realpath(root), target); } catch { return false; }
      }));
      return allowed.some(Boolean)
        && isApplication(target, info.isDirectory(), platform)
        && normalizedName(application.name) === normalizedName(applicationName(target));
    } catch { return false; }
  };

  const find = async (name: string): Promise<Application | undefined> => {
    const query = normalizedName(name);
    const candidates = (await load()).filter((application) => {
      const candidate = normalizedName(application.name);
      return candidate === query;
    });
    if (candidates.length !== 1 || !await validTarget(candidates[0]!)) return undefined;
    return candidates[0];
  };

  const route = async (input: SendMessageInput, fallback: Fallback, signal?: AbortSignal): Promise<AsyncIterable<MessageEvent>> => {
    const requested = requestedApplication(input);
    if (requested === undefined) return fallback(input, signal);
    let application = await find(requested);
    if (application === undefined) {
      await refresh();
      application = await find(requested);
    }
    if (application === undefined) return fallback(input, signal);

    const text = input.blocks[0]!.type === "text" ? input.blocks[0]!.text.trim() : "";
    const target = application.path;
    const result = `${application.name} 已打开。`;
    const digest = createHash("sha256").update(input.clientRequestId).digest("hex").slice(0, 24);
    const runId = `local_${digest}`;
    const createdAt = new Date().toISOString();
    return (async function* () {
      yield MessageEventSchema.parse({ type: "started", runId, sessionId: input.sessionId });
      await options.inject(input.sessionId, text, "uclaw-local-user-v1", signal);
      const openError = await options.openPath(target);
      if (openError !== "") throw new Error("Local application failed to open.");
      await options.inject(input.sessionId, result, "uclaw-local-result-v1", signal);
      yield MessageEventSchema.parse({
        type: "final", runId,
        message: {
          id: `local_message_${digest}`, sessionId: input.sessionId, runId, role: "assistant", status: "completed",
          blocks: [{ id: `local_block_${digest}`, type: "text", text: result, format: "plain" }], createdAt,
        },
      });
    })();
  };

  return { refresh, route };
}
