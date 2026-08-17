#!/usr/bin/env node
/**
 * App load-time measurement harness (Linux headless Chromium via CDP).
 *
 * Measures cold-cache page loads of the production build served by the bb
 * server, per route, and reports medians across runs:
 *   - FCP / LCP (PerformanceObserver, buffered)
 *   - route-ready: first appearance of a route-specific DOM marker
 *   - JS transfer/waterfall: every script fetched before route-ready
 *
 * IMPORTANT LABELING: numbers produced here are headless Chromium on the
 * Linux VM over localhost. They are NOT Electron numbers; treat them as
 * relative (before/after) signals for renderer boot cost. Electron cold
 * start, macOS compositor behavior, and real disk/network are unmeasured —
 * see the strago repro steps in KEEP_DITCH.md.
 *
 * Usage:
 *   node scripts/measure-load.mjs --base http://127.0.0.1:38886 \
 *     [--runs 7] [--routes /,/settings] [--label after] [--cpu 4]
 *
 * Requires google-chrome on PATH (headless). No npm dependencies: raw CDP
 * over the DevTools websocket using Node's built-in WebSocket.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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
const CPU_THROTTLE = Number(argValue("cpu", "4"));
const ROUTES = argValue("routes", "/,/settings")
  .split(",")
  .map((route) => route.trim())
  .filter(Boolean);

/** Route-specific "content is actually on screen" markers. */
function routeReadyMarker(route) {
  if (route.startsWith("/threads/")) {
    return "[data-promptbox-editor-content], main [contenteditable='true']";
  }
  if (route.startsWith("/settings")) {
    return "input, [role='radiogroup'], [data-settings-content], main h1, main h2";
  }
  return "[data-promptbox-editor-content], main [contenteditable='true']";
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
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
    this.listeners = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== undefined) {
        const entry = this.pending.get(message.id);
        if (entry) {
          this.pending.delete(message.id);
          if (message.error) entry.reject(new Error(message.error.message));
          else entry.resolve(message.result);
        }
        return;
      }
      const handlers = this.listeners.get(message.method);
      if (handlers) for (const handler of handlers) handler(message.params);
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  on(method, handler) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(handler);
  }
}

async function connect(port) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
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

const OBSERVER_SNIPPET = `(() => {
  window.__perf = { fcp: null, lcp: null };
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.name === "first-contentful-paint") window.__perf.fcp = entry.startTime;
    }
  }).observe({ type: "paint", buffered: true });
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      window.__perf.lcp = entry.startTime;
    }
  }).observe({ type: "largest-contentful-paint", buffered: true });
})();`;

async function measureOnce(route) {
  const profileDir = mkdtempSync(join(tmpdir(), "bb-load-"));
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
      "--window-size=1440,900",
      "about:blank",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let debugPort = null;
  const portPromise = new Promise((resolve) => {
    chrome.stderr.on("data", (data) => {
      const match = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(
        String(data),
      );
      if (match) resolve(Number(match[1]));
    });
  });
  debugPort = await portPromise;

  try {
    const browser = await connect(debugPort);
    const { targetInfos } = await browser.send("Target.getTargets");
    const page = targetInfos.find((target) => target.type === "page");
    const { sessionId } = await browser.send("Target.attachToTarget", {
      targetId: page.targetId,
      flatten: true,
    });
    const session = {
      send: (method, params = {}) => {
        const id = browser.nextId++;
        browser.socket.send(JSON.stringify({ id, method, params, sessionId }));
        return new Promise((resolve, reject) => {
          browser.pending.set(id, { resolve, reject });
        });
      },
    };

    await session.send("Page.enable");
    await session.send("Runtime.enable");
    await session.send("Network.enable");
    if (CPU_THROTTLE > 1) {
      await session.send("Emulation.setCPUThrottlingRate", {
        rate: CPU_THROTTLE,
      });
    }
    await session.send("Page.addScriptToEvaluateOnNewDocument", {
      source: OBSERVER_SNIPPET,
    });

    const marker = routeReadyMarker(route);
    const startWall = Date.now();
    await session.send("Page.navigate", { url: `${BASE}${route}` });

    // Poll for route-ready marker.
    let routeReadyMs = null;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const { result } = await session.send("Runtime.evaluate", {
        expression: `document.querySelector(${JSON.stringify(marker)}) !== null && performance.now()`,
        returnByValue: true,
      });
      if (typeof result.value === "number") {
        routeReadyMs = result.value;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    // Give LCP a settling beat, then read observers + resource waterfall.
    await new Promise((resolve) => setTimeout(resolve, 400));
    const { result: perfResult } = await session.send("Runtime.evaluate", {
      expression: `JSON.stringify({
        perf: window.__perf,
        nav: performance.getEntriesByType("navigation")[0]?.toJSON?.() ?? null,
        scripts: performance.getEntriesByType("resource")
          .filter((entry) => entry.initiatorType === "script" || entry.name.endsWith(".js"))
          .map((entry) => ({
            name: entry.name.split("/").pop(),
            start: Math.round(entry.startTime),
            end: Math.round(entry.responseEnd),
            transfer: entry.transferSize,
          })),
      })`,
      returnByValue: true,
    });
    const data = JSON.parse(perfResult.value);
    return {
      route,
      fcp: data.perf.fcp,
      lcp: data.perf.lcp,
      routeReady: routeReadyMs,
      wallMs: Date.now() - startWall,
      scripts: data.scripts,
      domContentLoaded: data.nav?.domContentLoadedEventEnd ?? null,
    };
  } finally {
    chrome.kill("SIGKILL");
    setTimeout(() => rmSync(profileDir, { recursive: true, force: true }), 500);
  }
}

const results = {};
for (const route of ROUTES) {
  results[route] = [];
  for (let run = 0; run < RUNS; run += 1) {
    const sample = await measureOnce(route);
    results[route].push(sample);
    process.stderr.write(
      `${LABEL} ${route} run ${run + 1}/${RUNS}: fcp=${sample.fcp?.toFixed(0)}ms lcp=${sample.lcp?.toFixed(0)}ms ready=${sample.routeReady?.toFixed(0)}ms\n`,
    );
  }
}

console.log(`\n=== ${LABEL} (headless Chromium, localhost, ${CPU_THROTTLE}x CPU throttle, cold cache, ${RUNS} runs, medians) ===`);
for (const route of ROUTES) {
  const samples = results[route];
  console.log(`route ${route}`);
  console.log(`  FCP:         ${median(samples.map((sample) => sample.fcp ?? NaN)).toFixed(0)} ms`);
  console.log(`  LCP:         ${median(samples.map((sample) => sample.lcp ?? NaN)).toFixed(0)} ms`);
  console.log(`  route-ready: ${median(samples.map((sample) => sample.routeReady ?? NaN)).toFixed(0)} ms`);
  const lastRun = samples[samples.length - 1];
  const scripts = [...lastRun.scripts].sort((left, right) => left.start - right.start);
  console.log("  script waterfall (last run):");
  for (const script of scripts) {
    console.log(
      `    ${String(script.start).padStart(6)}→${String(script.end).padStart(6)} ms  ${Math.round((script.transfer ?? 0) / 1024).toString().padStart(5)} KB  ${script.name}`,
    );
  }
}
