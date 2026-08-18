// Reproducible perf/integration harness for the real desktop shell
// (apps/desktop). Measures, against the actual built main process + preload:
//
//   startup      spawn → app-ready → page first frame / FCP / bbDesktop bridge
//   window-open  perf-harness stdin command → real window-factory window →
//                first frame in the new window
//   input        CDP-driven typing (Input.dispatchKeyEvent) and paste-sized
//                Input.insertText into a contenteditable; latency from CDP
//                send to the frame after the input event
//   scroll       CDP-driven mouse wheel over a 5k-row list; rAF frame cadence
//   memory       PSS/RSS over the whole process tree after startup settle
//   startup-real optional: full product cold start (shell spawns bb-app and
//                loads the built SPA); needs `turbo run build --filter=@bb/desktop`
//
// The shell attaches to a stub bb server (perf-server.mjs) and loads
// perf-page.html through BB_DESKTOP_APP_URL, so the fixture scenarios isolate
// shell/renderer behavior from bb-app server boot time. Requires:
//   pnpm exec turbo run build --filter=@bb/desktop   (or bb-app for -real)
//   a display (run under xvfb-run on headless Linux)
//
// Usage:
//   node perf/run-desktop-perf.mjs [--iterations N] [--scenarios fixture,startup-real]
//
// Results: perf/results/<timestamp>/desktop-perf.{json,md} — every run is
// labeled with platform/arch/display so VM numbers are never mistaken for
// user-hardware numbers.

import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  connectToTarget,
  waitForDevtoolsPort,
  waitForPageTarget,
} from "./cdp.mjs";
import { startPerfServer } from "./perf-server.mjs";
import { sampleProcessTreeMemory } from "./proc-mem.mjs";

const perfDir = dirname(fileURLToPath(import.meta.url));
const desktopDir = join(perfDir, "..");
const desktopRequire = createRequire(join(desktopDir, "package.json"));
const electronBinary = desktopRequire("electron");
const electronVersion = desktopRequire("electron/package.json").version;

const REPORT_TIMEOUT_MS = 60_000;
const REAL_APP_TIMEOUT_MS = 180_000;
const SETTLE_MS = 1500;
const TYPED_CHARS = 40;
const TYPED_GAP_MS = 30;
const PASTE_SIZES = [10_000, 100_000];
const SCROLL_CAPTURE_MS = 2500;
const SCROLL_WHEEL_EVENTS = 100;
const SCROLL_WHEEL_GAP_MS = 16;

function parseArgs(argv) {
  const args = { iterations: 5, scenarios: ["fixture"] };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--iterations") {
      args.iterations = Number(argv[i + 1]);
      i += 1;
    } else if (argv[i] === "--scenarios") {
      args.scenarios = argv[i + 1].split(",");
      i += 1;
    }
  }
  return args;
}

function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function summarize(samples) {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    count: samples.length,
    maxMs: sorted[sorted.length - 1],
    meanMs: samples.reduce((a, b) => a + b, 0) / samples.length,
    minMs: sorted[0],
    p50Ms: quantile(sorted, 0.5),
    p95Ms: quantile(sorted, 0.95),
  };
}

function median(values) {
  const usable = values.filter(
    (value) => typeof value === "number" && !Number.isNaN(value),
  );
  if (usable.length === 0) return null;
  return quantile(
    [...usable].sort((a, b) => a - b),
    0.5,
  );
}

async function findFreePort() {
  return await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        reject(new Error("could not allocate a free port"));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
    probe.on("error", reject);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

async function stopShell(child) {
  child.kill("SIGTERM");
  if (await waitForExit(child, 8000)) return;
  child.kill("SIGKILL");
  await waitForExit(child, 5000);
}

function launchShell({ env, userDataDir }) {
  const marks = new Map();
  const stderrChunks = [];
  const spawnEpochMs = Date.now();
  const child = spawn(
    electronBinary,
    [
      `--user-data-dir=${userDataDir}`,
      "--remote-debugging-port=0",
      desktopDir,
    ],
    {
      cwd: desktopDir,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  child.stdout.setEncoding("utf8");
  let buffered = "";
  const markWaiters = [];
  child.stdout.on("data", (chunk) => {
    buffered += chunk;
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (typeof parsed.bbPerf === "string") {
          marks.set(parsed.bbPerf, parsed.tMs);
          markWaiters.forEach((entry) => entry());
        }
      } catch {
        // Non-mark output.
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    stderrChunks.push(String(chunk));
    if (stderrChunks.length > 400) stderrChunks.shift();
  });

  return {
    child,
    marks,
    spawnEpochMs,
    stderrText: () => stderrChunks.join(""),
    async waitForMark(name, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const value = marks.get(name);
        if (value !== undefined) return value;
        if (Date.now() > deadline) {
          throw new Error(`timed out waiting for shell mark ${name}`);
        }
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 100);
          markWaiters.push(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    },
  };
}

function baseShellEnv() {
  const env = {
    ...process.env,
    BB_DESKTOP_PERF_HARNESS: "1",
    BB_DESKTOP_OPEN_DEVTOOLS: "0",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.BB_DESKTOP_APP_URL;
  return env;
}

async function driveInputScenario(cdp) {
  // Typing: keyDown-with-text produces one beforeinput/input pair per char in
  // a contenteditable, like real typing (without OS keyboard layout effects).
  await cdp.evaluate("window.__bbPerfStartInputCapture()");
  const typedSendEpochs = [];
  for (let i = 0; i < TYPED_CHARS; i += 1) {
    const char = String.fromCharCode(97 + (i % 26));
    typedSendEpochs.push(Date.now());
    await cdp.send("Input.dispatchKeyEvent", {
      code: `Key${char.toUpperCase()}`,
      key: char,
      text: char,
      type: "keyDown",
    });
    await cdp.send("Input.dispatchKeyEvent", {
      code: `Key${char.toUpperCase()}`,
      key: char,
      type: "keyUp",
    });
    await sleep(TYPED_GAP_MS);
  }
  await sleep(300);
  const typedSamples = await cdp.evaluate("window.__bbPerfReadInputSamples()");
  const typedLatencies = typedSamples
    .map((sample, index) =>
      index < typedSendEpochs.length
        ? sample.frameEpochMs - typedSendEpochs[index]
        : null,
    )
    .filter((value) => value !== null);

  // Paste: one Input.insertText per size, which is the code path a clipboard
  // paste takes through the IME pipeline (single input event, no key events).
  const pastes = [];
  for (const size of PASTE_SIZES) {
    await cdp.evaluate("window.__bbPerfStartInputCapture()");
    const sendEpochMs = Date.now();
    await cdp.send("Input.insertText", { text: "x".repeat(size) });
    const cdpAckMs = Date.now() - sendEpochMs;
    await sleep(400);
    const samples = await cdp.evaluate("window.__bbPerfReadInputSamples()");
    pastes.push({
      cdpAckMs,
      chars: size,
      inputToFrameMs:
        samples.length > 0
          ? samples[0].frameEpochMs - samples[0].inputEpochMs
          : null,
      sendToFrameMs:
        samples.length > 0 ? samples[0].frameEpochMs - sendEpochMs : null,
    });
  }

  return {
    pastes,
    typing: {
      ...summarize(typedLatencies),
      note: "CDP send → frame after input event, per typed char",
    },
  };
}

async function driveScrollScenario(cdp) {
  const rect = await cdp.evaluate("window.__bbPerfListRect()");
  const x = rect.x + rect.width / 2;
  const y = rect.y + rect.height / 2;
  await cdp.evaluate(
    `window.__bbPerfStartScrollCapture(${SCROLL_CAPTURE_MS})`,
  );
  for (let i = 0; i < SCROLL_WHEEL_EVENTS; i += 1) {
    await cdp.send("Input.dispatchMouseEvent", {
      deltaX: 0,
      deltaY: 240,
      type: "mouseWheel",
      x,
      y,
    });
    await sleep(SCROLL_WHEEL_GAP_MS);
  }
  await sleep(SCROLL_CAPTURE_MS + 600 - SCROLL_WHEEL_EVENTS * SCROLL_WHEEL_GAP_MS);
  const capture = await cdp.evaluate("window.__bbPerfReadScroll()");
  if (capture === null || capture.deltas.length === 0) {
    throw new Error("scroll capture returned no frames");
  }
  if (capture.endScrollTop <= capture.startScrollTop) {
    throw new Error("wheel events did not scroll the list");
  }
  const summary = summarize(capture.deltas);
  summary.droppedFramePct =
    (capture.deltas.filter((d) => d > 34).length / capture.deltas.length) * 100;
  summary.scrolledPx = capture.endScrollTop - capture.startScrollTop;
  return summary;
}

async function runFixtureIteration({ iteration }) {
  const runRoot = await mkdtemp(join(tmpdir(), `bb-desktop-perf-${iteration}-`));
  const userDataDir = join(runRoot, "user-data");
  const dataDir = join(runRoot, "data");
  await mkdir(userDataDir, { recursive: true });
  const server = await startPerfServer({ dataDir });

  const env = baseShellEnv();
  env.BB_DATA_DIR = dataDir;
  env.BB_SERVER_PORT = String(server.port);
  env.BB_DESKTOP_APP_URL = `${server.url}/perf-page.html`;

  const shell = launchShell({ env, userDataDir });
  let cdp = null;
  try {
    const startupReport = await server.waitForReport(0, REPORT_TIMEOUT_MS);
    const appReadyMs = await shell.waitForMark("app-ready", 5000);
    const mainStartMs = await shell.waitForMark("main-start", 5000);

    await sleep(SETTLE_MS);
    const memory = await sampleProcessTreeMemory(shell.child.pid);

    const devtoolsPort = await waitForDevtoolsPort(userDataDir, 10_000);
    const target = await waitForPageTarget(
      devtoolsPort,
      (url) => url.includes("perf-page.html"),
      10_000,
    );
    cdp = await connectToTarget(target);

    const input = await driveInputScenario(cdp);
    const scroll = await driveScrollScenario(cdp);

    const openRequestEpochMs = Date.now();
    shell.child.stdin.write("open-window\n");
    const openReport = await server.waitForReport(1, 30_000);
    const openCreatedMs = await shell.waitForMark("open-window-created", 10_000);

    return {
      iteration,
      metrics: {
        input,
        memoryProcessCount: memory.processCount,
        memoryPssMb: memory.totalPssKb / 1024,
        memoryRssMb: memory.totalRssKb / 1024,
        scroll,
        startup: {
          appReadyMs: appReadyMs - shell.spawnEpochMs,
          bridgeReadyMs:
            startupReport.bridgeReadyMs === null
              ? null
              : startupReport.bridgeReadyMs - shell.spawnEpochMs,
          fcpMs:
            startupReport.fcpMs === null
              ? null
              : startupReport.fcpMs - shell.spawnEpochMs,
          firstFrameMs: startupReport.firstRafMs - shell.spawnEpochMs,
          mainStartMs: mainStartMs - shell.spawnEpochMs,
        },
        windowOpen: {
          createdMs: openCreatedMs - openRequestEpochMs,
          firstFrameMs: openReport.firstRafMs - openRequestEpochMs,
        },
      },
      spawnEpochMs: shell.spawnEpochMs,
    };
  } catch (error) {
    throw new Error(
      `fixture iteration ${iteration} failed: ${
        error instanceof Error ? error.message : String(error)
      }\nshell stderr (tail):\n${shell.stderrText().slice(-4000)}`,
    );
  } finally {
    cdp?.close();
    await stopShell(shell.child);
    await server.close();
    await rm(runRoot, { force: true, recursive: true });
  }
}

async function runRealStartupIteration({ iteration }) {
  const runRoot = await mkdtemp(join(tmpdir(), `bb-desktop-real-${iteration}-`));
  const userDataDir = join(runRoot, "user-data");
  const dataDir = join(runRoot, "data");
  await mkdir(userDataDir, { recursive: true });
  const serverPort = await findFreePort();

  const env = baseShellEnv();
  env.BB_DATA_DIR = dataDir;
  env.BB_SERVER_PORT = String(serverPort);
  // The bridge spawns bb-app with this node when running unpackaged.
  env.BB_DESKTOP_NODE_EXEC_PATH = process.execPath;

  const shell = launchShell({ env, userDataDir });
  let cdp = null;
  try {
    const appReadyMs = await shell.waitForMark("app-ready", 30_000);
    const devtoolsPort = await waitForDevtoolsPort(userDataDir, 30_000);
    const serverUrl = `http://127.0.0.1:${serverPort}`;
    const target = await waitForPageTarget(
      devtoolsPort,
      (url) => url.startsWith(serverUrl),
      REAL_APP_TIMEOUT_MS,
    );
    cdp = await connectToTarget(target);
    const pageTimings = await cdp.evaluate(
      `(async () => {
        if (document.readyState !== "complete") {
          await new Promise((r) => addEventListener("load", r, { once: true }));
        }
        await new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(r)),
        );
        const firstFrameEpochMs = performance.timeOrigin + performance.now();
        // The FCP entry lands asynchronously after the first paint, which for
        // the SPA can be well after the load event; poll for it briefly.
        const findFcp = () =>
          performance
            .getEntriesByType("paint")
            .find((e) => e.name === "first-contentful-paint");
        let fcp = findFcp();
        const deadline = performance.now() + 5000;
        while (fcp === undefined && performance.now() < deadline) {
          await new Promise((r) => setTimeout(r, 100));
          fcp = findFcp();
        }
        const nav = performance.getEntriesByType("navigation")[0];
        return {
          fcpEpochMs:
            fcp === undefined ? null : performance.timeOrigin + fcp.startTime,
          loadEpochMs:
            nav === undefined
              ? null
              : performance.timeOrigin + nav.loadEventEnd,
          firstFrameEpochMs,
        };
      })()`,
      { awaitPromise: true },
    );

    await sleep(3000);
    const memory = await sampleProcessTreeMemory(shell.child.pid);

    return {
      iteration,
      metrics: {
        appReadyMs: appReadyMs - shell.spawnEpochMs,
        fcpMs:
          pageTimings.fcpEpochMs === null
            ? null
            : pageTimings.fcpEpochMs - shell.spawnEpochMs,
        firstFrameMs: pageTimings.firstFrameEpochMs - shell.spawnEpochMs,
        loadMs:
          pageTimings.loadEpochMs === null
            ? null
            : pageTimings.loadEpochMs - shell.spawnEpochMs,
        memoryProcessCount: memory.processCount,
        memoryPssMb: memory.totalPssKb / 1024,
        memoryRssMb: memory.totalRssKb / 1024,
      },
    };
  } catch (error) {
    throw new Error(
      `startup-real iteration ${iteration} failed: ${
        error instanceof Error ? error.message : String(error)
      }\nshell stderr (tail):\n${shell.stderrText().slice(-4000)}`,
    );
  } finally {
    cdp?.close();
    await stopShell(shell.child);
    await rm(runRoot, { force: true, recursive: true });
  }
}

function aggregateFixture(iterations) {
  const scalar = (pick) => median(iterations.map(pick));
  return {
    memoryProcessCount: scalar((it) => it.metrics.memoryProcessCount),
    memoryPssMb: scalar((it) => it.metrics.memoryPssMb),
    memoryRssMb: scalar((it) => it.metrics.memoryRssMb),
    pasteBySize: PASTE_SIZES.map((size, index) => ({
      chars: size,
      sendToFrameMs: scalar(
        (it) => it.metrics.input.pastes[index]?.sendToFrameMs ?? null,
      ),
    })),
    scrollDroppedFramePct: scalar((it) => it.metrics.scroll.droppedFramePct),
    scrollMeanFrameMs: scalar((it) => it.metrics.scroll.meanMs),
    scrollP95FrameMs: scalar((it) => it.metrics.scroll.p95Ms),
    startupAppReadyMs: scalar((it) => it.metrics.startup.appReadyMs),
    startupBridgeReadyMs: scalar((it) => it.metrics.startup.bridgeReadyMs),
    startupFcpMs: scalar((it) => it.metrics.startup.fcpMs),
    startupFirstFrameMs: scalar((it) => it.metrics.startup.firstFrameMs),
    typingP50Ms: scalar((it) => it.metrics.input.typing?.p50Ms ?? null),
    typingP95Ms: scalar((it) => it.metrics.input.typing?.p95Ms ?? null),
    windowOpenCreatedMs: scalar((it) => it.metrics.windowOpen.createdMs),
    windowOpenFirstFrameMs: scalar((it) => it.metrics.windowOpen.firstFrameMs),
  };
}

function aggregateReal(iterations) {
  const scalar = (pick) => median(iterations.map(pick));
  return {
    appReadyMs: scalar((it) => it.metrics.appReadyMs),
    fcpMs: scalar((it) => it.metrics.fcpMs),
    firstFrameMs: scalar((it) => it.metrics.firstFrameMs),
    loadMs: scalar((it) => it.metrics.loadMs),
    memoryProcessCount: scalar((it) => it.metrics.memoryProcessCount),
    memoryPssMb: scalar((it) => it.metrics.memoryPssMb),
    memoryRssMb: scalar((it) => it.metrics.memoryRssMb),
  };
}

function formatMs(value) {
  return value === null ? "n/a" : value.toFixed(value < 10 ? 2 : 0);
}

function renderMarkdown(results) {
  const lines = [
    `# Desktop shell perf (Electron ${electronVersion})`,
    "",
    `- date: ${results.environment.date}`,
    `- host: ${results.environment.platform}/${results.environment.arch}, display ${results.environment.display ?? "none"}`,
    `- ${results.environment.note}`,
    "",
  ];
  if (results.fixture?.aggregate != null) {
    const a = results.fixture.aggregate;
    lines.push(
      "## Fixture scenarios (real shell, stub bb server, instrumented page)",
      "",
      "| metric (median of runs) | value |",
      "| --- | --- |",
      `| startup → app-ready (ms) | ${formatMs(a.startupAppReadyMs)} |`,
      `| startup → first frame (ms) | ${formatMs(a.startupFirstFrameMs)} |`,
      `| startup → FCP (ms) | ${formatMs(a.startupFcpMs)} |`,
      `| startup → bbDesktop bridge ready (ms) | ${formatMs(a.startupBridgeReadyMs)} |`,
      `| window open → created+loaded (ms) | ${formatMs(a.windowOpenCreatedMs)} |`,
      `| window open → first frame (ms) | ${formatMs(a.windowOpenFirstFrameMs)} |`,
      `| typing latency p50 (ms) | ${formatMs(a.typingP50Ms)} |`,
      `| typing latency p95 (ms) | ${formatMs(a.typingP95Ms)} |`,
      ...a.pasteBySize.map(
        (paste) =>
          `| paste ${paste.chars / 1000}k chars → frame (ms) | ${formatMs(paste.sendToFrameMs)} |`,
      ),
      `| scroll mean frame (ms) | ${formatMs(a.scrollMeanFrameMs)} |`,
      `| scroll p95 frame (ms) | ${formatMs(a.scrollP95FrameMs)} |`,
      `| scroll dropped frames (%) | ${formatMs(a.scrollDroppedFramePct)} |`,
      `| memory PSS (MB) | ${formatMs(a.memoryPssMb)} |`,
      `| memory RSS sum (MB) | ${formatMs(a.memoryRssMb)} |`,
      `| process count | ${formatMs(a.memoryProcessCount)} |`,
      "",
    );
  }
  if (results.startupReal?.aggregate != null) {
    const a = results.startupReal.aggregate;
    lines.push(
      "## Full product cold start (shell spawns bb-app, loads built SPA)",
      "",
      "| metric (median of runs) | value |",
      "| --- | --- |",
      `| spawn → app-ready (ms) | ${formatMs(a.appReadyMs)} |`,
      `| spawn → SPA load event (ms) | ${formatMs(a.loadMs)} |`,
      `| spawn → SPA FCP (ms) | ${formatMs(a.fcpMs)} |`,
      `| memory PSS incl. bb-app (MB) | ${formatMs(a.memoryPssMb)} |`,
      `| process count | ${formatMs(a.memoryProcessCount)} |`,
      "",
    );
  }
  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv);
  const results = {
    args,
    electronVersion,
    environment: {
      arch: process.arch,
      date: new Date().toISOString(),
      display: process.env.DISPLAY ?? null,
      note: "Collected on a headless Linux VM under Xvfb (software rendering) unless stated otherwise. Absolute numbers are not representative of end-user macOS hardware; compare runs on the same machine only.",
      platform: process.platform,
    },
  };

  if (args.scenarios.includes("fixture")) {
    const iterations = [];
    try {
      for (let i = 1; i <= args.iterations; i += 1) {
        console.error(`fixture run ${i}/${args.iterations}…`);
        const iteration = await runFixtureIteration({ iteration: i });
        iterations.push(iteration);
        console.error(
          `  first frame ${iteration.metrics.startup.firstFrameMs}ms, ` +
            `window open ${iteration.metrics.windowOpen.firstFrameMs}ms, ` +
            `PSS ${iteration.metrics.memoryPssMb.toFixed(1)}MB`,
        );
      }
      results.fixture = { aggregate: aggregateFixture(iterations), iterations };
    } catch (error) {
      // Keep whatever completed; a failed scenario must not lose the rest.
      results.fixture = {
        aggregate: iterations.length > 0 ? aggregateFixture(iterations) : null,
        error: error instanceof Error ? error.message : String(error),
        iterations,
      };
      console.error(`fixture scenario failed: ${results.fixture.error}`);
      process.exitCode = 1;
    }
  }

  if (args.scenarios.includes("startup-real")) {
    const iterations = [];
    const realIterationCount = Math.min(args.iterations, 3);
    try {
      for (let i = 1; i <= realIterationCount; i += 1) {
        console.error(`startup-real run ${i}/${realIterationCount}…`);
        const iteration = await runRealStartupIteration({ iteration: i });
        iterations.push(iteration);
        console.error(
          `  SPA FCP ${formatMs(iteration.metrics.fcpMs)}ms, ` +
            `PSS ${iteration.metrics.memoryPssMb.toFixed(1)}MB`,
        );
      }
      results.startupReal = { aggregate: aggregateReal(iterations), iterations };
    } catch (error) {
      results.startupReal = {
        aggregate: iterations.length > 0 ? aggregateReal(iterations) : null,
        error: error instanceof Error ? error.message : String(error),
        iterations,
      };
      console.error(`startup-real scenario failed: ${results.startupReal.error}`);
      process.exitCode = 1;
    }
  }

  const outDir = join(
    perfDir,
    "results",
    new Date().toISOString().replace(/[:.]/g, "-"),
  );
  await mkdir(outDir, { recursive: true });
  await writeFile(
    join(outDir, "desktop-perf.json"),
    `${JSON.stringify(results, null, 2)}\n`,
  );
  const markdown = renderMarkdown(results);
  await writeFile(join(outDir, "desktop-perf.md"), `${markdown}\n`);
  console.log(`\n${markdown}`);
  console.log(`results written to ${outDir}`);
}

await main();
