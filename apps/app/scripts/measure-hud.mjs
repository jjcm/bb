#!/usr/bin/env node
/**
 * Cold-load "usable HUD" measurement harness (headless Chromium via CDP).
 *
 * This measures what a person waiting on a cold browser load actually waits
 * for, which is deliberately different from `measure-load.mjs`:
 *
 *   - hud:      first painted frame containing the sidebar *and* an enabled
 *               "New thread" control. This is the primary number.
 *   - composer: time from clicking "New thread" until the composer's
 *               "Ask anything." placeholder is painted. Secondary number.
 *
 * Both markers are recorded on the frame *after* the DOM condition first
 * holds, so a value means "the browser painted it", not "React inserted it".
 * Document `load` and HTML TTFB are deliberately not reported: `load` fires
 * before React paints anything, so it cannot rank HUD changes.
 *
 * Every run uses a fresh browser profile and `Network.setCacheDisabled`, so
 * each sample is a cold load. Default viewport 1440x900, no CPU throttle.
 *
 * LABELING: these are Linux headless Chromium numbers over localhost, not
 * Electron and not macOS. Use them as before/after signal only.
 *
 * Usage:
 *   node scripts/measure-hud.mjs --base http://127.0.0.1:38886 \
 *     [--runs 7] [--label after] [--cpu 1] [--route /] [--json out.json]
 *
 * Requires google-chrome on PATH. No npm dependencies.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
}

const BASE = argValue("base", "http://127.0.0.1:38886");
const RUNS = Number(argValue("runs", "7"));
const LABEL = argValue("label", "run");
const CPU_THROTTLE = Number(argValue("cpu", "1"));
const ROUTE = argValue("route", "/");
const JSON_OUT = argValue("json", null);
const VIEWPORT_WIDTH = Number(argValue("width", "1440"));
const VIEWPORT_HEIGHT = Number(argValue("height", "900"));
/** Skip the New-thread click leg when only the primary number is wanted. */
const HUD_ONLY = args.includes("--hud-only");
/**
 * --profile: sample the main thread from navigation until the HUD paints and
 * print self time per script and per (script, function). Sampling perturbs
 * timing, so never compare a profiled run's HUD number against an unprofiled
 * one; use it only to decide where the pre-HUD work is.
 */
const PROFILE = args.includes("--profile");

/**
 * Sidebar panel plus a usable "New thread" control. `aria-label` is used
 * rather than text because the label carries the keyboard shortcut once the
 * command registry resolves, and `:not([disabled])` keeps a control that
 * paints in a disabled state from counting as usable.
 */
const HUD_SELECTORS = {
  sidebar: '[data-sidebar="sidebar"]',
  newThread:
    'button[aria-label="New thread"]:not([disabled]), button[aria-label^="New thread ("]:not([disabled])',
};
/**
 * The composer placeholder only renders once ProseMirror exists and TipTap's
 * placeholder decoration has been applied, so this cannot pass on the
 * promptbox wrapper alone.
 */
const COMPOSER_SELECTOR =
  '[data-promptbox-editor-content] p.is-editor-empty[data-placeholder^="Ask anything"]';

function median(values) {
  const usable = values.filter((value) => typeof value === "number");
  if (usable.length === 0) return NaN;
  const sorted = [...usable].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

async function fetchJson(url) {
  const response = await fetch(url);
  return response.json();
}

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id === undefined) return;
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
    });
  }

  send(method, params = {}, sessionId = undefined) {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }
}

async function connect(port) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const version = await fetchJson(`http://127.0.0.1:${port}/json/version`);
      const socket = new WebSocket(version.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        socket.addEventListener("open", resolve, { once: true });
        socket.addEventListener("error", reject, { once: true });
      });
      return new Cdp(socket);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error("could not connect to Chrome devtools");
}

/**
 * Installed before any app script runs. A rAF loop tests the marker
 * condition, then records the timestamp from the *next* frame callback, which
 * runs after the frame that satisfied the condition was painted. During a long
 * task no frame callback runs at all, so a marker lands at the first painted
 * frame after the blocking work — which is the number a waiting person feels.
 */
const WATCHER_SNIPPET = `(() => {
  const hud = { hudMs: null, composerMs: null, composerClickMs: null };
  window.__hud = hud;
  const sidebarSelector = ${JSON.stringify(HUD_SELECTORS.sidebar)};
  const newThreadSelector = ${JSON.stringify(HUD_SELECTORS.newThread)};
  const composerSelector = ${JSON.stringify(COMPOSER_SELECTOR)};

  function isPaintable(element) {
    if (element === null) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function afterPaint(record) {
    requestAnimationFrame(() => requestAnimationFrame(() => record(performance.now())));
  }

  let hudDone = false;
  let composerDone = false;
  function tick() {
    if (!hudDone) {
      const sidebar = document.querySelector(sidebarSelector);
      const newThread = document.querySelector(newThreadSelector);
      if (isPaintable(sidebar) && isPaintable(newThread)) {
        hudDone = true;
        afterPaint((now) => { hud.hudMs = now; });
      }
    }
    if (!composerDone && hud.composerClickMs !== null) {
      if (isPaintable(document.querySelector(composerSelector))) {
        composerDone = true;
        afterPaint((now) => { hud.composerMs = now; });
      }
    }
    if (!hudDone || !composerDone) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
})();`;

function launchChrome() {
  const profileDir = mkdtempSync(join(tmpdir(), "bb-hud-"));
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
      "--no-default-browser-check",
      "--disable-background-timer-throttling",
      `--window-size=${VIEWPORT_WIDTH},${VIEWPORT_HEIGHT}`,
      "about:blank",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const portPromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("chrome did not report a devtools port")),
      30_000,
    );
    chrome.stderr.on("data", (data) => {
      const match = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(
        String(data),
      );
      if (match) {
        clearTimeout(timeout);
        resolve(Number(match[1]));
      }
    });
  });
  return { chrome, profileDir, portPromise };
}

async function waitFor(read, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null && value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return null;
}

async function measureOnce() {
  const { chrome, profileDir, portPromise } = launchChrome();
  try {
    const debugPort = await portPromise;
    const browser = await connect(debugPort);
    const { targetInfos } = await browser.send("Target.getTargets");
    const pageTarget = targetInfos.find((target) => target.type === "page");
    const { sessionId } = await browser.send("Target.attachToTarget", {
      targetId: pageTarget.targetId,
      flatten: true,
    });
    const send = (method, params) => browser.send(method, params, sessionId);

    await send("Page.enable");
    await send("Runtime.enable");
    await send("Network.enable");
    await send("Network.setCacheDisabled", { cacheDisabled: true });
    await send("Emulation.setDeviceMetricsOverride", {
      width: VIEWPORT_WIDTH,
      height: VIEWPORT_HEIGHT,
      deviceScaleFactor: 1,
      mobile: false,
    });
    if (CPU_THROTTLE > 1) {
      await send("Emulation.setCPUThrottlingRate", { rate: CPU_THROTTLE });
    }
    await send("Page.addScriptToEvaluateOnNewDocument", {
      source: WATCHER_SNIPPET,
    });
    if (PROFILE) {
      await send("Profiler.enable");
      await send("Profiler.setSamplingInterval", { interval: 200 });
      await send("Profiler.start");
    }

    const scriptBytes = { total: 0, count: 0 };
    await send("Page.navigate", { url: `${BASE}${ROUTE}` });

    const readHud = async () => {
      const { result } = await send("Runtime.evaluate", {
        expression: "window.__hud ? window.__hud.hudMs : null",
        returnByValue: true,
      });
      return result.value ?? null;
    };
    const hudMs = await waitFor(readHud, 60_000);

    let profileByKey = null;
    if (PROFILE) {
      const { profile } = await send("Profiler.stop");
      const microsByNode = new Map();
      for (let index = 0; index < (profile.samples ?? []).length; index += 1) {
        const nodeId = profile.samples[index];
        microsByNode.set(
          nodeId,
          (microsByNode.get(nodeId) ?? 0) + (profile.timeDeltas?.[index] ?? 0),
        );
      }
      profileByKey = new Map();
      for (const node of profile.nodes) {
        const micros = microsByNode.get(node.id);
        if (!micros) continue;
        const url = node.callFrame.url || "(no url)";
        const chunk = url.split("/").pop() || url;
        profileByKey.set(chunk, (profileByKey.get(chunk) ?? 0) + micros);
        const fn = `${chunk} :: ${node.callFrame.functionName || "(anonymous)"}`;
        profileByKey.set(fn, (profileByKey.get(fn) ?? 0) + micros);
      }
    }

    let composerMs = null;
    let composerClickMs = null;
    if (!HUD_ONLY && hudMs !== null) {
      const { result: boxResult } = await send("Runtime.evaluate", {
        expression: `(() => {
          const button = document.querySelector(${JSON.stringify(HUD_SELECTORS.newThread)});
          if (!button) return null;
          const rect = button.getBoundingClientRect();
          return JSON.stringify({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
        })()`,
        returnByValue: true,
      });
      if (typeof boxResult.value === "string") {
        const box = JSON.parse(boxResult.value);
        const { result: clickStamp } = await send("Runtime.evaluate", {
          expression:
            "window.__hud.composerClickMs = performance.now(), window.__hud.composerClickMs",
          returnByValue: true,
        });
        composerClickMs = clickStamp.value;
        for (const type of ["mousePressed", "mouseReleased"]) {
          await send("Input.dispatchMouseEvent", {
            type,
            x: box.x,
            y: box.y,
            button: "left",
            clickCount: 1,
            buttons: type === "mousePressed" ? 1 : 0,
          });
        }
        const readComposer = async () => {
          const { result } = await send("Runtime.evaluate", {
            expression: "window.__hud.composerMs",
            returnByValue: true,
          });
          return result.value ?? null;
        };
        composerMs = await waitFor(readComposer, 60_000);
      }
    }

    const { result: detailResult } = await send("Runtime.evaluate", {
      expression: `JSON.stringify({
        fcp: performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? null,
        scripts: performance.getEntriesByType("resource")
          .filter((entry) => entry.name.endsWith(".js"))
          .map((entry) => ({
            name: entry.name.split("/").pop(),
            start: Math.round(entry.startTime),
            end: Math.round(entry.responseEnd),
            transfer: entry.transferSize,
          })),
      })`,
      returnByValue: true,
    });
    const detail = JSON.parse(detailResult.value);
    for (const script of detail.scripts) {
      scriptBytes.total += script.transfer ?? 0;
      scriptBytes.count += 1;
    }

    return {
      hudMs,
      composerMs:
        composerMs !== null && composerClickMs !== null
          ? composerMs - composerClickMs
          : null,
      composerAbsoluteMs: composerMs,
      fcp: detail.fcp,
      scripts: detail.scripts,
      scriptBytes,
      profileByKey,
    };
  } finally {
    chrome.kill("SIGKILL");
    setTimeout(() => rmSync(profileDir, { recursive: true, force: true }), 500);
  }
}

const samples = [];
for (let run = 0; run < RUNS; run += 1) {
  const sample = await measureOnce();
  samples.push(sample);
  process.stderr.write(
    `${LABEL} run ${run + 1}/${RUNS}: hud=${sample.hudMs?.toFixed(0) ?? "n/a"}ms ` +
      `composer(+click)=${sample.composerMs?.toFixed(0) ?? "n/a"}ms ` +
      `fcp=${sample.fcp?.toFixed(0) ?? "n/a"}ms\n`,
  );
}

const summary = {
  label: LABEL,
  base: BASE,
  route: ROUTE,
  runs: RUNS,
  cpuThrottle: CPU_THROTTLE,
  viewport: `${VIEWPORT_WIDTH}x${VIEWPORT_HEIGHT}`,
  hudMedian: median(samples.map((sample) => sample.hudMs)),
  hudSamples: samples.map((sample) => sample.hudMs),
  composerMedian: median(samples.map((sample) => sample.composerMs)),
  composerSamples: samples.map((sample) => sample.composerMs),
  fcpMedian: median(samples.map((sample) => sample.fcp)),
  scriptKbLastRun: Math.round((samples.at(-1)?.scriptBytes.total ?? 0) / 1024),
  scriptCountLastRun: samples.at(-1)?.scriptBytes.count ?? 0,
};

console.log(
  `\n=== ${LABEL} — headless Chromium, ${summary.viewport}, cache disabled, cold profile per run, ` +
    `${CPU_THROTTLE}x CPU, ${RUNS} runs (medians) ===`,
);
console.log(
  `  HUD (sidebar + New thread painted): ${summary.hudMedian.toFixed(0)} ms`,
);
console.log(
  `    samples: ${summary.hudSamples.map((value) => value?.toFixed(0) ?? "n/a").join(", ")}`,
);
console.log(
  `  Composer "Ask anything." after click: ${summary.composerMedian.toFixed(0)} ms`,
);
console.log(
  `    samples: ${summary.composerSamples.map((value) => value?.toFixed(0) ?? "n/a").join(", ")}`,
);
console.log(`  FCP (context only): ${summary.fcpMedian.toFixed(0)} ms`);
console.log(
  `  JS transferred (last run): ${summary.scriptKbLastRun} KB across ${summary.scriptCountLastRun} scripts`,
);

const lastRun = samples.at(-1);
if (lastRun && args.includes("--waterfall")) {
  console.log("  script waterfall (last run):");
  for (const script of [...lastRun.scripts].sort((a, b) => a.start - b.start)) {
    console.log(
      `    ${String(script.start).padStart(6)}→${String(script.end).padStart(6)} ms  ` +
        `${Math.round((script.transfer ?? 0) / 1024)
          .toString()
          .padStart(5)} KB  ${script.name}`,
    );
  }
}

if (lastRun?.profileByKey) {
  console.log("  main-thread self time until HUD (last run):");
  const entries = [...lastRun.profileByKey.entries()].sort(
    (left, right) => right[1] - left[1],
  );
  for (const [key, micros] of entries) {
    const ms = micros / 1000;
    if (ms < 5) continue;
    console.log(`    ${ms.toFixed(0).padStart(6)} ms  ${key}`);
  }
}

if (JSON_OUT) {
  writeFileSync(JSON_OUT, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`  wrote ${JSON_OUT}`);
}
