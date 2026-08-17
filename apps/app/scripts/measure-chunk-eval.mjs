#!/usr/bin/env node
/**
 * Measures the MARGINAL module-evaluation cost of built chunks in headless
 * Chromium (4× CPU throttle), on the app origin: dependencies are imported
 * first, then the target chunk's import() is timed alone. This isolates
 * parse+compile+execute from render work — the sampling profiler
 * (measure-load.mjs --profile) attributes render frames to whichever chunk
 * defines them, which conflates the two.
 *
 * IMPORTANT LABELING: Linux headless Chromium numbers, not Electron.
 *
 * Usage (server running, dist built):
 *   node scripts/measure-chunk-eval.mjs '[{"name":"<chunk>.js","deps":["<dep>.js",...]}]'
 * Chunk dependency lists come from bundle-stats-all.json
 * (BB_BUNDLE_STATS_ALL=1 pnpm run build).
 */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.env.BB_MEASURE_BASE ?? "http://127.0.0.1:38886";
const targets = JSON.parse(process.argv[2] ?? "[]");
if (targets.length === 0) {
  console.error("pass a JSON array of {name, deps} chunk descriptors");
  process.exit(1);
}

const profileDir = mkdtempSync(join(tmpdir(), "bb-eval-"));
const chrome = spawn(
  "google-chrome",
  [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "about:blank",
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);
const port = await new Promise((resolve) => {
  chrome.stderr.on("data", (data) => {
    const match = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(
      String(data),
    );
    if (match) resolve(Number(match[1]));
  });
});
const version = await (
  await fetch(`http://127.0.0.1:${port}/json/version`)
).json();
const socket = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((resolve) =>
  socket.addEventListener("open", resolve, { once: true }),
);
let nextId = 1;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.id) {
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  }
});
const send = (method, params = {}, sessionId) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

const {
  result: { targetInfos },
} = await send("Target.getTargets");
const page = targetInfos.find((target) => target.type === "page");
const {
  result: { sessionId },
} = await send("Target.attachToTarget", {
  targetId: page.targetId,
  flatten: true,
});
await send("Page.enable", {}, sessionId);
await send("Runtime.enable", {}, sessionId);
await send("Emulation.setCPUThrottlingRate", { rate: 4 }, sessionId);
// A same-origin non-SPA document, so no app JS runs before the imports.
await send("Page.navigate", { url: `${BASE}/api/v1/system/version` }, sessionId);
await new Promise((resolve) => setTimeout(resolve, 1500));

for (const target of targets) {
  const expression = `(async () => {
    for (const dep of ${JSON.stringify(target.deps ?? [])}) {
      await import("/assets/" + dep);
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    const start = performance.now();
    await import("/assets/${target.name}");
    return Math.round(performance.now() - start);
  })()`;
  const { result } = await send(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
  );
  console.log(
    target.name,
    "marginal eval:",
    result.result?.value ??
      JSON.stringify(result.exceptionDetails?.exception?.description ?? result),
    "ms (4x throttle)",
  );
}
chrome.kill("SIGKILL");
