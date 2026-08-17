#!/usr/bin/env node
/**
 * Warm in-app navigation harness (headless Chromium via CDP).
 *
 * `measure-hud.mjs` measures the cold load: how long until the SPA first
 * paints a usable HUD. This measures the other half of the hosted web app,
 * which is where a user spends nearly all of their time: the SPA is *already
 * up* and they click something.
 *
 * Each run loads `/`, waits until the shell is genuinely settled (sidebar +
 * New thread painted, root composer painted, then a quiet beat), and only then
 * performs a fixed sequence of real clicks, timing each from the in-page
 * `mousedown` until the destination content is painted:
 *
 *   threadOpen1  first thread opened in the session — pays the lazy
 *                ThreadDetailView chunk. Primary metric.
 *   threadOpen2  a second, different thread — that chunk is now warm, so this
 *                isolates per-thread work from one-time chunk cost.
 *   newThread    back to the root composer ("Ask anything." painted).
 *   settings     a heavy non-thread view, as a third probe.
 *
 * Markers are recorded on the animation frame *after* the DOM condition first
 * holds, so a number means the browser painted it. During a long task no frame
 * callback runs, so a marker lands on the first painted frame after the
 * blocking work — which is what the waiting person feels.
 *
 * LABELING: production build, headless Chromium on Linux over localhost. Not
 * Electron, not Vite dev. Relative before/after signal only.
 *
 * Usage:
 *   node scripts/measure-warm-nav.mjs --base http://127.0.0.1:38886 \
 *     [--runs 7] [--label after] [--cpu 1] [--json out.json] [--waterfall]
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
const JSON_OUT = argValue("json", null);
const VIEWPORT_WIDTH = Number(argValue("width", "1440"));
const VIEWPORT_HEIGHT = Number(argValue("height", "900"));
/** Quiet beat after the shell paints, so probes measure warm work only. */
const SETTLE_MS = Number(argValue("settle", "600"));
const WATERFALL = args.includes("--waterfall");
/**
 * --profile <probe>: sample the main thread for the named probe's window only
 * and print self time per script and per (script, function). Sampling perturbs
 * timing, so never compare a profiled run's numbers against an unprofiled one.
 */
const PROFILE_PROBE = argValue("profile", null);
/**
 * --counters: report each probe's script / style-recalc / layout time from
 * Chromium's own counters, which splits "the main thread was busy" into JS
 * versus style and layout. Much cheaper than sampling and does not perturb.
 */
const COUNTERS = args.includes("--counters");

/** The sidebar's own New-thread button carries the shortcut in its label; the
 * per-project row buttons ("New thread in <project>") do not. */
const NEW_THREAD_BUTTON =
  'button[aria-label^="New thread ("]:not([disabled]), button[aria-label="New thread"]:not([disabled])';
const SIDEBAR = '[data-sidebar="sidebar"]';
const THREAD_ROW = "[data-sidebar-thread-id]";
const TIMELINE_ROW = "[data-timeline-row-id]";
const COMPOSER_PLACEHOLDER =
  '[data-promptbox-editor-content] p.is-editor-empty[data-placeholder^="Ask anything"]';
const SETTINGS_LINK = 'a[href^="/settings"]';
const SETTINGS_CONTENT =
  'main h1, main h2, main [role="radiogroup"], main input';

const PROBES = ["threadOpen1", "threadOpen2", "newThread", "settings"];

function median(values) {
  const usable = values.filter((value) => typeof value === "number");
  if (usable.length === 0) return NaN;
  const sorted = [...usable].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
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
      const version = await (
        await fetch(`http://127.0.0.1:${port}/json/version`)
      ).json();
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
 * Page-side helpers. `arm` installs a one-shot capture-phase `mousedown`
 * stamp, so a probe's clock starts at the real input event rather than at a
 * CDP round trip, and then polls the predicate on every frame.
 */
const HELPERS_SNIPPET = `(() => {
  const state = { t0: null, doneAt: null };
  window.__warm = state;
  window.__warmVisible = (selector) => {
    const element = document.querySelector(selector);
    if (element === null) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  window.__warmArm = (predicateSource) => {
    state.t0 = null;
    state.doneAt = null;
    const predicate = new Function("return (" + predicateSource + ")");
    const stamp = (event) => { if (state.t0 === null) state.t0 = event.timeStamp; };
    window.addEventListener("mousedown", stamp, { capture: true, once: true });
    const tick = () => {
      if (state.t0 !== null && predicate()) {
        requestAnimationFrame(() =>
          requestAnimationFrame(() => { state.doneAt = performance.now(); }),
        );
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
})();`;

function launchChrome() {
  const profileDir = mkdtempSync(join(tmpdir(), "bb-warm-"));
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
    const evaluate = async (expression) => {
      const { result } = await send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      return result.value;
    };

    await send("Page.enable");
    await send("Runtime.enable");
    if (COUNTERS) await send("Performance.enable", {});
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
      source: HELPERS_SNIPPET,
    });
    await send("Page.navigate", { url: `${BASE}/` });

    // Warm-up: the SPA has to be genuinely up before a click means anything.
    const shellReady = await waitUntil(
      () =>
        evaluate(
          `window.__warmVisible && window.__warmVisible(${JSON.stringify(SIDEBAR)}) &&
           window.__warmVisible(${JSON.stringify(NEW_THREAD_BUTTON)}) &&
           window.__warmVisible(${JSON.stringify(COMPOSER_PLACEHOLDER)})`,
        ),
      60_000,
    );
    if (!shellReady) return failedRun("shell never settled");
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    const scriptsBefore = await evaluate(
      `performance.getEntriesByType("resource").filter((e) => e.name.endsWith(".js")).length`,
    );

    const results = {};
    const probeStarts = {};
    const clickTargets = await evaluate(`JSON.stringify(
      [...document.querySelectorAll(${JSON.stringify(THREAD_ROW)})]
        .map((el) => ({ id: el.getAttribute("data-sidebar-thread-id"), rect: el.getBoundingClientRect().toJSON() }))
        .filter((entry) => entry.rect.top >= 0 && entry.rect.bottom <= window.innerHeight && entry.rect.width > 0)
    )`);
    const rows = JSON.parse(clickTargets);
    if (rows.length < 2) return failedRun("fewer than two visible thread rows");

    // 1. First thread open in the session: includes the lazy pane chunk.
    results.threadOpen1 = await probe(
      send,
      evaluate,
      `window.__warmVisible(${JSON.stringify(TIMELINE_ROW)})`,
      centerOf(rows[0].rect),
      probeStarts,
      "threadOpen1",
    );

    // 2. Second, different thread: pane chunk is warm. Waiting for a row id
    //    that was not on screen before the click avoids passing on the
    //    previous thread's rows while the new one loads.
    const previousRowIds = await evaluate(
      `JSON.stringify([...document.querySelectorAll(${JSON.stringify(TIMELINE_ROW)})].map((el) => el.getAttribute("data-timeline-row-id")))`,
    );
    results.threadOpen2 = await probe(
      send,
      evaluate,
      `(() => { const seen = new Set(${previousRowIds});
        return [...document.querySelectorAll(${JSON.stringify(TIMELINE_ROW)})]
          .some((el) => !seen.has(el.getAttribute("data-timeline-row-id")) && el.getBoundingClientRect().height > 0); })()`,
      centerOf(rows[1].rect),
      probeStarts,
      "threadOpen2",
    );

    // 3. Back to the root composer. Requiring the timeline to be gone keeps a
    //    thread's own follow-up composer from satisfying this.
    const newThreadRect = JSON.parse(
      await evaluate(
        `JSON.stringify(document.querySelector(${JSON.stringify(NEW_THREAD_BUTTON)}).getBoundingClientRect().toJSON())`,
      ),
    );
    results.newThread = await probe(
      send,
      evaluate,
      `document.querySelector(${JSON.stringify(TIMELINE_ROW)}) === null &&
       window.__warmVisible(${JSON.stringify(COMPOSER_PLACEHOLDER)})`,
      centerOf(newThreadRect),
      probeStarts,
      "newThread",
    );

    // 4. A heavy non-thread view.
    const settingsRect = JSON.parse(
      await evaluate(
        `JSON.stringify(document.querySelector(${JSON.stringify(SETTINGS_LINK)}).getBoundingClientRect().toJSON())`,
      ),
    );
    results.settings = await probe(
      send,
      evaluate,
      `window.__warmVisible(${JSON.stringify(SETTINGS_CONTENT)})`,
      centerOf(settingsRect),
      probeStarts,
      "settings",
    );

    const scripts = JSON.parse(
      await evaluate(`JSON.stringify(
        performance.getEntriesByType("resource")
          .filter((entry) => entry.name.endsWith(".js"))
          .map((entry) => ({ name: entry.name.split("/").pop(), start: Math.round(entry.startTime), end: Math.round(entry.responseEnd), transfer: entry.transferSize })))`),
    );
    const requests = JSON.parse(
      await evaluate(`JSON.stringify(
        performance.getEntriesByType("resource")
          .filter((entry) => entry.initiatorType === "fetch" || entry.initiatorType === "xmlhttprequest")
          .map((entry) => ({ name: entry.name.replace(location.origin, ""), start: Math.round(entry.startTime), end: Math.round(entry.responseEnd) })))`),
    );
    return { ...results, scriptsBefore, scripts, requests, probeStarts };
  } finally {
    chrome.kill("SIGKILL");
    setTimeout(() => rmSync(profileDir, { recursive: true, force: true }), 500);
  }
}

function failedRun(reason) {
  const empty = { reason, scripts: [] };
  for (const name of PROBES) empty[name] = null;
  return empty;
}

function centerOf(rect) {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

async function waitUntil(read, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await read()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

/** Arm the watcher, click, then read the painted-at delta. */
async function readCounters(send) {
  if (!COUNTERS) return null;
  const { metrics } = await send("Performance.getMetrics", {});
  const byName = {};
  for (const metric of metrics) byName[metric.name] = metric.value;
  return byName;
}

async function probe(send, evaluate, predicateSource, point, starts, name) {
  const countersBefore = await readCounters(send);
  const profiling = PROFILE_PROBE !== null && PROFILE_PROBE === name;
  if (profiling) {
    await send("Profiler.enable", {});
    await send("Profiler.setSamplingInterval", { interval: 200 });
    await send("Profiler.start", {});
  }
  await evaluate(`window.__warmArm(${JSON.stringify(predicateSource)})`);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", {
      type,
      x: point.x,
      y: point.y,
      button: "left",
      clickCount: 1,
      buttons: type === "mousePressed" ? 1 : 0,
    });
  }
  const ok = await waitUntil(
    async () => (await evaluate(`window.__warm.doneAt !== null`)) === true,
    30_000,
  );
  if (profiling) {
    const { profile } = await send("Profiler.stop", {});
    const microsByNode = new Map();
    for (let index = 0; index < (profile.samples ?? []).length; index += 1) {
      const nodeId = profile.samples[index];
      microsByNode.set(
        nodeId,
        (microsByNode.get(nodeId) ?? 0) + (profile.timeDeltas?.[index] ?? 0),
      );
    }
    const byKey = new Map();
    for (const node of profile.nodes) {
      const micros = microsByNode.get(node.id);
      if (!micros) continue;
      const chunk = (node.callFrame.url || "(no url)").split("/").pop();
      byKey.set(chunk, (byKey.get(chunk) ?? 0) + micros);
      const fn = `${chunk} :: ${node.callFrame.functionName || "(anonymous)"}`;
      byKey.set(fn, (byKey.get(fn) ?? 0) + micros);
    }
    console.log(`\n  main-thread self time during ${name} (sampled):`);
    for (const [key, micros] of [...byKey.entries()].sort(
      (a, b) => b[1] - a[1],
    )) {
      const ms = micros / 1000;
      if (ms < 4) continue;
      console.log(`    ${ms.toFixed(0).padStart(6)} ms  ${key}`);
    }
  }
  if (!ok) return null;
  const pair = JSON.parse(
    await evaluate(`JSON.stringify([window.__warm.t0, window.__warm.doneAt])`),
  );
  const countersAfter = await readCounters(send);
  if (starts !== undefined && name !== undefined) {
    starts[name] = { t0: Math.round(pair[0]), doneAt: Math.round(pair[1]) };
    if (countersBefore !== null && countersAfter !== null) {
      const delta = (key) =>
        Math.round(
          ((countersAfter[key] ?? 0) - (countersBefore[key] ?? 0)) * 1000,
        );
      starts[name].counters = {
        taskMs: delta("TaskDuration"),
        scriptMs: delta("ScriptDuration"),
        recalcStyleMs: delta("RecalcStyleDuration"),
        layoutMs: delta("LayoutDuration"),
        layoutCount: Math.round(
          (countersAfter.LayoutCount ?? 0) - (countersBefore.LayoutCount ?? 0),
        ),
        recalcStyleCount: Math.round(
          (countersAfter.RecalcStyleCount ?? 0) -
            (countersBefore.RecalcStyleCount ?? 0),
        ),
        nodes: Math.round(countersAfter.Nodes ?? 0),
      };
    }
  }
  return pair[1] - pair[0];
}

const samples = [];
for (let run = 0; run < RUNS; run += 1) {
  const sample = await measureOnce();
  samples.push(sample);
  process.stderr.write(
    `${LABEL} run ${run + 1}/${RUNS}: ` +
      PROBES.map(
        (name) => `${name}=${sample[name]?.toFixed(0) ?? "n/a"}ms`,
      ).join(" ") +
      (sample.reason ? `  (${sample.reason})` : "") +
      "\n",
  );
}

const summary = {
  label: LABEL,
  base: BASE,
  runs: RUNS,
  cpuThrottle: CPU_THROTTLE,
  viewport: `${VIEWPORT_WIDTH}x${VIEWPORT_HEIGHT}`,
  settleMs: SETTLE_MS,
  probes: {},
};
for (const name of PROBES) {
  const values = samples.map((sample) => sample[name]);
  summary.probes[name] = { median: median(values), samples: values };
}

console.log(
  `\n=== ${LABEL} — warm in-app navigation, production build, headless Chromium, ` +
    `${summary.viewport}, ${CPU_THROTTLE}x CPU, ${RUNS} runs (medians) ===`,
);
for (const name of PROBES) {
  const probeSummary = summary.probes[name];
  console.log(
    `  ${name.padEnd(13)} ${probeSummary.median.toFixed(0).padStart(6)} ms`,
  );
  console.log(
    `                samples: ${probeSummary.samples.map((value) => value?.toFixed(0) ?? "n/a").join(", ")}`,
  );
}

const lastRun = samples.at(-1);
if (WATERFALL && lastRun) {
  console.log(
    `  scripts already loaded when the shell settled: ${lastRun.scriptsBefore}`,
  );
  console.log("  probe windows on the page clock (last run):");
  for (const name of PROBES) {
    const window = lastRun.probeStarts?.[name];
    if (!window) continue;
    const counters = window.counters;
    console.log(
      `    ${name.padEnd(13)} ${String(window.t0).padStart(6)}→${String(window.doneAt).padStart(6)} ms` +
        (counters
          ? `   task=${String(counters.taskMs).padStart(4)} script=${String(counters.scriptMs).padStart(4)} style=${String(counters.recalcStyleMs).padStart(4)}(${counters.recalcStyleCount}) layout=${String(counters.layoutMs).padStart(4)}(${counters.layoutCount}) nodes=${counters.nodes}`
          : ""),
    );
  }
  console.log("  scripts fetched during the warm probes (last run):");
  for (const script of lastRun.scripts.slice(lastRun.scriptsBefore)) {
    console.log(
      `    ${String(script.start).padStart(6)}→${String(script.end).padStart(6)} ms  ` +
        `${Math.round((script.transfer ?? 0) / 1024)
          .toString()
          .padStart(5)} KB  ${script.name}`,
    );
  }
}

if (WATERFALL && lastRun) {
  const firstProbeStart = lastRun.probeStarts?.threadOpen1?.t0 ?? 0;
  console.log("  API requests during the warm probes (last run):");
  for (const request of (lastRun.requests ?? []).filter(
    (entry) => entry.end >= firstProbeStart,
  )) {
    console.log(
      `    ${String(request.start).padStart(6)}→${String(request.end).padStart(6)} ms  ${request.name}`,
    );
  }
}

if (JSON_OUT) {
  writeFileSync(JSON_OUT, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`  wrote ${JSON_OUT}`);
}
