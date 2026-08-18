// Wrapper spike comparison orchestrator.
//
// Spawns each shell (Electron BrowserWindow, Electron WebContentsView, Tauri /
// WebKitGTK) against the same fixture page N times and measures:
//   - cold start:  spawn → first rAF frame (cross-engine) and → FCP (where
//                  supported), plus bridge-ready
//   - memory:      PSS/RSS of the whole process tree after a settle period
//   - window open: stdin command → second window first frame
//   - IPC:         renderer↔shell round trips, 8-byte and 256 KiB payloads
//   - scroll:      rAF frame cadence during programmatic scroll of 5k rows
//
// Usage: node run-compare.mjs [--iterations N] [--shells a,b,c]
// Shells: electron-browserwindow, electron-webcontentsview, tauri
//
// Results land in results/<timestamp>/compare.json plus a markdown summary on
// stdout. Linux-only (memory sampling reads /proc).

import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startFixtureServer } from "./shared/fixture-server.mjs";
import { sampleProcessTreeMemory } from "./shared/proc-mem.mjs";

const spikeRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(spikeRoot, "..", "..");
// The spikes deliberately live outside the pnpm workspace; reuse the Electron
// binary that apps/desktop already downloaded so both Electron spikes run the
// exact same Electron version as the product shell.
const desktopRequire = createRequire(
  join(repoRoot, "apps", "desktop", "package.json"),
);
const electronBinary = desktopRequire("electron");
const electronVersion =
  desktopRequire("electron/package.json").version ?? "unknown";
const tauriBinary = join(
  spikeRoot,
  "tauri-shell",
  "src-tauri",
  "target",
  "release",
  "spike-tauri-shell",
);

const SETTLE_MS = 1500;
const REPORT_TIMEOUT_MS = 60_000;
const WINDOW_OPEN_TIMEOUT_MS = 30_000;

function parseArgs(argv) {
  const args = { iterations: 5, shells: null };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--iterations") {
      args.iterations = Number(argv[i + 1]);
      i += 1;
    } else if (argv[i] === "--shells") {
      args.shells = argv[i + 1].split(",");
      i += 1;
    }
  }
  return args;
}

const SHELLS = {
  "electron-browserwindow": {
    bridge: "electron",
    command: (ctx) => ({
      args: [
        `--user-data-dir=${ctx.stateDir}`,
        join(spikeRoot, "electron-shell", "main.cjs"),
      ],
      binary: electronBinary,
      env: { SPIKE_MODE: "browserwindow" },
    }),
    label: `Electron ${electronVersion} BrowserWindow`,
  },
  "electron-webcontentsview": {
    bridge: "electron",
    command: (ctx) => ({
      args: [
        `--user-data-dir=${ctx.stateDir}`,
        join(spikeRoot, "electron-shell", "main.cjs"),
      ],
      binary: electronBinary,
      env: { SPIKE_MODE: "webcontentsview" },
    }),
    label: `Electron ${electronVersion} BaseWindow+WebContentsView`,
  },
  tauri: {
    bridge: "tauri",
    command: (ctx) => ({
      args: [],
      binary: tauriBinary,
      // Point WebKitGTK's XDG state at the per-run dir so every iteration is
      // a genuine cold start with empty caches, like the Electron user-data
      // dir.
      env: {
        XDG_CACHE_HOME: join(ctx.stateDir, "cache"),
        XDG_CONFIG_HOME: join(ctx.stateDir, "config"),
        XDG_DATA_HOME: join(ctx.stateDir, "data"),
      },
    }),
    label: "Tauri 2 (WebKitGTK)",
  },
};

function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function median(values) {
  const usable = values.filter((v) => typeof v === "number" && !Number.isNaN(v));
  if (usable.length === 0) return null;
  return quantile(
    [...usable].sort((a, b) => a - b),
    0.5,
  );
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
  child.stdin.write("quit\n", () => {});
  if (await waitForExit(child, 3000)) return;
  child.kill("SIGTERM");
  if (await waitForExit(child, 3000)) return;
  child.kill("SIGKILL");
  await waitForExit(child, 3000);
}

async function runIteration({ fixture, iteration, shellId }) {
  const shell = SHELLS[shellId];
  const runId = `${shellId}-${iteration}`;
  const stateDir = await mkdtemp(join(tmpdir(), `spike-${runId}-`));
  const { args, binary, env } = shell.command({ stateDir });
  const fixtureUrl = `${fixture.url}?shell=${shell.bridge}&run=${runId}`;

  const events = new Map();
  const stderrChunks = [];
  const spawnEpochMs = Date.now();
  const child = spawn(binary, args, {
    env: {
      ...process.env,
      ...env,
      SPIKE_FIXTURE_URL: fixtureUrl,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  let buffered = "";
  child.stdout.on("data", (chunk) => {
    buffered += chunk;
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (typeof parsed.perf === "string") {
          events.set(parsed.perf, parsed.tMs);
        }
      } catch {
        // Non-protocol output; ignore.
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    stderrChunks.push(String(chunk));
    if (stderrChunks.length > 200) stderrChunks.shift();
  });

  try {
    const win1 = await fixture.waitForReport(runId, 1, REPORT_TIMEOUT_MS);
    if (win1.error !== undefined) {
      throw new Error(`fixture page reported error: ${win1.error}`);
    }

    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    const memory = await sampleProcessTreeMemory(child.pid);

    const openRequestEpochMs = Date.now();
    child.stdin.write("open-window\n");
    const win2 = await fixture.waitForReport(runId, 2, WINDOW_OPEN_TIMEOUT_MS);

    return {
      iteration,
      memory,
      metrics: {
        appReadyMs: (events.get("app-ready") ?? NaN) - spawnEpochMs,
        bridgeReadyFromSpawnMs:
          win1.bridgeReadyMs === null ? null : win1.bridgeReadyMs - spawnEpochMs,
        coldStartFcpMs: win1.fcpMs === null ? null : win1.fcpMs - spawnEpochMs,
        coldStartFirstFrameMs: win1.firstRafMs - spawnEpochMs,
        ipcLarge: win1.ipcLarge ?? null,
        ipcSmall: win1.ipcSmall ?? null,
        memoryPssMb: memory.totalPssKb / 1024,
        memoryProcessCount: memory.processCount,
        memoryRssMb: memory.totalRssKb / 1024,
        scroll: win1.scroll ?? null,
        windowOpenFcpMs:
          win2.fcpMs === null ? null : win2.fcpMs - openRequestEpochMs,
        windowOpenFirstFrameMs: win2.firstRafMs - openRequestEpochMs,
      },
      runId,
      shellEvents: Object.fromEntries(events),
      spawnEpochMs,
    };
  } catch (error) {
    const stderrText = stderrChunks.join("").trim();
    throw new Error(
      `${runId} failed: ${error instanceof Error ? error.message : String(error)}` +
        (stderrText.length > 0 ? `\nshell stderr:\n${stderrText}` : ""),
    );
  } finally {
    await stopShell(child);
    await rm(stateDir, { force: true, recursive: true });
  }
}

function aggregate(iterations) {
  const scalar = (pick) => median(iterations.map(pick));
  return {
    appReadyMs: scalar((it) => it.metrics.appReadyMs),
    bridgeReadyFromSpawnMs: scalar((it) => it.metrics.bridgeReadyFromSpawnMs),
    coldStartFcpMs: scalar((it) => it.metrics.coldStartFcpMs),
    coldStartFirstFrameMs: scalar((it) => it.metrics.coldStartFirstFrameMs),
    ipcLargeP50Ms: scalar((it) => it.metrics.ipcLarge?.p50Ms ?? null),
    ipcLargeP95Ms: scalar((it) => it.metrics.ipcLarge?.p95Ms ?? null),
    ipcSmallP50Ms: scalar((it) => it.metrics.ipcSmall?.p50Ms ?? null),
    ipcSmallP95Ms: scalar((it) => it.metrics.ipcSmall?.p95Ms ?? null),
    memoryProcessCount: scalar((it) => it.metrics.memoryProcessCount),
    memoryPssMb: scalar((it) => it.metrics.memoryPssMb),
    memoryRssMb: scalar((it) => it.metrics.memoryRssMb),
    scrollDroppedFramePct: scalar((it) => it.metrics.scroll?.droppedFramePct),
    scrollMeanFrameMs: scalar((it) => it.metrics.scroll?.meanMs),
    scrollP95FrameMs: scalar((it) => it.metrics.scroll?.p95Ms),
    windowOpenFcpMs: scalar((it) => it.metrics.windowOpenFcpMs),
    windowOpenFirstFrameMs: scalar((it) => it.metrics.windowOpenFirstFrameMs),
  };
}

function formatMs(value) {
  return value === null ? "n/a" : `${value.toFixed(value < 10 ? 2 : 0)}`;
}

function renderMarkdown(results) {
  const rows = Object.entries(results.shells);
  const header = ["metric (median of runs)", ...rows.map(([, r]) => r.label)];
  const metrics = [
    ["cold start → first frame (ms)", (a) => formatMs(a.coldStartFirstFrameMs)],
    ["cold start → FCP (ms)", (a) => formatMs(a.coldStartFcpMs)],
    ["bridge ready from spawn (ms)", (a) => formatMs(a.bridgeReadyFromSpawnMs)],
    ["window open → first frame (ms)", (a) => formatMs(a.windowOpenFirstFrameMs)],
    ["IPC ping p50 (ms)", (a) => formatMs(a.ipcSmallP50Ms)],
    ["IPC ping p95 (ms)", (a) => formatMs(a.ipcSmallP95Ms)],
    ["IPC 256KiB echo p50 (ms)", (a) => formatMs(a.ipcLargeP50Ms)],
    ["scroll mean frame (ms)", (a) => formatMs(a.scrollMeanFrameMs)],
    ["scroll p95 frame (ms)", (a) => formatMs(a.scrollP95FrameMs)],
    ["scroll dropped frames (%)", (a) => formatMs(a.scrollDroppedFramePct)],
    ["memory PSS (MB)", (a) => formatMs(a.memoryPssMb)],
    ["memory RSS sum (MB)", (a) => formatMs(a.memoryRssMb)],
    ["process count", (a) => formatMs(a.memoryProcessCount)],
  ];
  const lines = [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
  ];
  for (const [name, render] of metrics) {
    lines.push(
      `| ${name} | ${rows.map(([, r]) => render(r.aggregate)).join(" | ")} |`,
    );
  }
  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv);
  const shellIds = args.shells ?? Object.keys(SHELLS);
  for (const shellId of shellIds) {
    if (SHELLS[shellId] === undefined) {
      throw new Error(`unknown shell: ${shellId}`);
    }
  }

  const fixture = await startFixtureServer();
  const results = {
    args: { iterations: args.iterations, shells: shellIds },
    environment: {
      arch: process.arch,
      date: new Date().toISOString(),
      display: process.env.DISPLAY ?? null,
      note: "Collected on a headless Linux VM under Xvfb (software rendering). Absolute numbers are not representative of end-user macOS hardware; use them for relative comparisons between shells on this machine only.",
      platform: process.platform,
    },
    shells: {},
  };

  try {
    for (const shellId of shellIds) {
      const iterations = [];
      console.error(`\n=== ${shellId} (${SHELLS[shellId].label}) ===`);
      for (let i = 1; i <= args.iterations; i += 1) {
        console.error(`  run ${i}/${args.iterations}…`);
        const iterationResult = await runIteration({
          fixture,
          iteration: i,
          shellId,
        });
        iterations.push(iterationResult);
        console.error(
          `    first frame ${iterationResult.metrics.coldStartFirstFrameMs}ms, ` +
            `PSS ${iterationResult.metrics.memoryPssMb.toFixed(1)}MB, ` +
            `window open ${iterationResult.metrics.windowOpenFirstFrameMs}ms`,
        );
      }
      results.shells[shellId] = {
        aggregate: aggregate(iterations),
        iterations,
        label: SHELLS[shellId].label,
      };
    }
  } finally {
    await fixture.close();
  }

  const outDir = join(
    spikeRoot,
    "results",
    new Date().toISOString().replace(/[:.]/g, "-"),
  );
  await mkdir(outDir, { recursive: true });
  await writeFile(
    join(outDir, "compare.json"),
    `${JSON.stringify(results, null, 2)}\n`,
  );
  const markdown = renderMarkdown(results);
  await writeFile(join(outDir, "compare.md"), `${markdown}\n`);
  console.log(`\n${markdown}\n`);
  console.log(`results written to ${outDir}`);
}

await main();
