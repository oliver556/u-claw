const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const controlUiDir = path.join(root, "node_modules", "openclaw", "dist", "control-ui");
const assetsDir = path.join(controlUiDir, "assets");
const swPath = path.join(controlUiDir, "sw.js");

function read(file) {
  return fs.readFileSync(file, "utf8");
}

function writeIfChanged(file, before, after) {
  if (before === after) return false;
  fs.writeFileSync(file, after);
  return true;
}

function patchChatPage() {
  if (!fs.existsSync(assetsDir)) {
    throw new Error(`Missing OpenClaw control-ui assets: ${assetsDir}`);
  }

  const files = fs
    .readdirSync(assetsDir)
    .filter((name) => /^chat-page-.*\.js$/.test(name))
    .map((name) => path.join(assetsDir, name));

  if (files.length === 0) {
    throw new Error(`Missing chat-page asset in ${assetsDir}`);
  }

  const replacement =
    "function Li(e){if(!e||typeof e!=`object`)return!1;let o=Q(e),t=Q(o?.message)??o;if(!t)return!1;let n=Q(t.provenance),r=typeof n?.sourceTool==`string`?n.sourceTool.toLowerCase():``;if(O(t.role)===`user`&&n?.kind===`inter_session`&&[`agent_harness_task`,`image_generate`,`music_generate`,`video_generate`].includes(r))return!0;if(O(t.role)!==`assistant`||typeof t.senderLabel==`string`&&t.senderLabel.trim())return!1;let{text:i,hasVisibleNonTextContent:a}=Ii(typeof t.content==`string`||Array.isArray(t.content)?t.content:t.text);return a?!1:Pi(i).shouldSkip}var Ri=";

  for (const file of files) {
    const before = read(file);
    if (before.includes("Q(o?.message)??o") && before.includes("`video_generate`")) {
      continue;
    }

    const after = before.replace(/function Li\(e\)\{[\s\S]*?\}var Ri=/, replacement);
    if (after === before) {
      throw new Error(`Could not patch internal media event filter in ${file}`);
    }
    writeIfChanged(file, before, after);
    console.log(`patched ${path.relative(root, file)}`);
  }
}

function patchServiceWorker() {
  if (!fs.existsSync(swPath)) {
    throw new Error(`Missing OpenClaw service worker: ${swPath}`);
  }

  let source = read(swPath);
  source = source.replace(
    /const EMBEDDED_CACHE_VERSION = "[^"]+";/,
    'const EMBEDDED_CACHE_VERSION = "2026.7.1-2-0790d9f593ad-uclaw-media-filter-2";',
  );
  source = source.replace(/const CONTROL_CACHE_LIMIT = \d+;/, "const CONTROL_CACHE_LIMIT = 1;");

  const fetchStart = source.indexOf('self.addEventListener("fetch", (event) => {');
  const webPushStart = source.indexOf("// --- Web Push ---");
  if (fetchStart === -1 || webPushStart === -1 || fetchStart > webPushStart) {
    throw new Error("Could not locate service worker fetch handler");
  }

  const fetchHandler = `self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Skip non-GET and cross-origin requests.
  if (event.request.method !== "GET" || url.origin !== self.location.origin) {
    return;
  }

  // Skip top-level navigations so the browser can handle HTTP auth
  // challenges natively - WWW-Authenticate dialogs are bypassed when the
  // response comes from a service worker, breaking reverse-proxy setups
  // with basic/digest auth in front of the gateway.
  if (event.request.mode === "navigate") {
    return;
  }

  // Skip non-UI routes - API, RPC, and plugin routes should never be cached.
  if (
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/rpc") ||
    url.pathname.startsWith("/plugins/")
  ) {
    return;
  }

  // Network-first for assets in the portable build so patched bundled UI files
  // are not masked by stale Service Worker cache.
  if (url.pathname.includes("/assets/")) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            void caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => caches.open(CACHE_NAME).then((cache) => cache.match(event.request))),
    );
  } else {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            void caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => caches.match(event.request)),
    );
  }
});

`;

  const next = source.slice(0, fetchStart) + fetchHandler + source.slice(webPushStart);
  if (writeIfChanged(swPath, read(swPath), next)) {
    console.log(`patched ${path.relative(root, swPath)}`);
  }
}

patchChatPage();
patchServiceWorker();
