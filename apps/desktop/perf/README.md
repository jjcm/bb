# Desktop shell perf harness

Reproducible integration/perf measurements for the real Electron shell
(`apps/desktop`): startup, window open, typing/paste input latency, scroll
frame cadence, and process-tree memory. Results land in `perf/results/`
as JSON plus a markdown summary, labeled with the host environment.

## How it works

- The runner spawns the actual built shell (`dist/main.js` via the workspace
  Electron binary) with a fresh user-data dir and data dir per iteration, so
  every run is a cold start.
- A stub bb server (`perf-server.mjs`) answers `/health` and
  `/api/v1/system/config`, so the shell takes the real attach path without
  booting a bb-app runtime (same trick as `scripts/smoke-packaged-app.mjs`).
- The shell loads `perf-page.html` through `BB_DESKTOP_APP_URL`. The page
  reports startup timings (first frame, FCP, `window.bbDesktop` bridge ready)
  back over HTTP, in `Date.now()`-calibrated epoch milliseconds so they align
  with the runner's spawn timestamp and the shell's stdout marks.
- `BB_DESKTOP_PERF_HARNESS=1` enables `src/perf-harness.ts`: the shell emits
  milestone marks as JSON lines on stdout (`main-start`, `app-ready`,
  `open-window-*`) and accepts an `open-window` command on stdin, which runs
  the real `createApplicationWindow` path (the same code path as the
  File → New Window menu item). The flag is harness-only; the app never sets
  it, and when unset the module is inert.
- Input and scroll are driven over CDP (`--remote-debugging-port=0`, port read
  from `DevToolsActivePort`): `Input.dispatchKeyEvent` per typed character,
  `Input.insertText` for paste-sized payloads (the clipboard-paste IME path),
  and `Input.dispatchMouseEvent` wheel events over a 5k-row list.
- Memory is PSS/RSS summed over the shell's process tree from
  `/proc/*/smaps_rollup` (Linux only; PSS splits shared pages fairly across
  Chromium's multi-process model).

## Running

```bash
pnpm exec turbo run build --filter=@bb/desktop
cd apps/desktop
node perf/run-desktop-perf.mjs --iterations 5
# headless Linux:
xvfb-run -a node perf/run-desktop-perf.mjs --iterations 5
```

Scenarios:

- `--scenarios fixture` (default): everything above against the stub server
  and instrumented page. Isolates shell/renderer behavior from bb-app boot.
- `--scenarios fixture,startup-real`: additionally measures full product cold
  start — the shell spawns a real bb-app runtime (requires the full
  `--filter=@bb/desktop` build, which builds bb-app) and the runner measures
  spawn → SPA load/FCP via CDP, plus process-tree memory including bb-app.

## Interpreting results

- Every results file records platform/arch/display and a warning note. Numbers
  from a headless Linux VM under Xvfb use software rendering; treat them as
  relative comparisons on that machine, never as user-facing absolutes.
- `typing latency` is CDP send → the frame after the `input` event. It
  excludes OS keyboard delivery (no way to drive that identically from CI),
  so it is a renderer/compositor number, not an end-to-end keypress number.
- `scroll` is driven by real wheel events, but the cadence number is rAF frame
  intervals during the burst; dropped = frames > 34 ms.

## macOS repro (needed for user-facing absolutes)

The harness itself is portable except memory sampling (`/proc`), which
degrades to zeros off-Linux — read macOS memory from Activity Monitor or
`footprint`/`ps` instead, or extend `proc-mem.mjs`. Steps on a Mac (e.g.
strago):

```bash
pnpm install
pnpm exec turbo run build --filter=@bb/desktop
cd apps/desktop
node perf/run-desktop-perf.mjs --iterations 5
```

On macOS the same harness exercises the packaged-relevant paths (frameless
window chrome, traffic lights) that Linux cannot, and produces GPU-composited
scroll/input numbers that are meaningful for real users.
