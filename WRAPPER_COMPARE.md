# Desktop wrapper comparison — Electron baseline vs alternative shells

Track B experiment: (1) a reproducible perf/integration harness for the real
Electron desktop shell, and (2) isolated spikes of alternative wrappers
(Electron `BrowserWindow` vs `BaseWindow`+`WebContentsView`, and Tauri 2 on the
system webview), measured against the same fixture.

**Verdict (final — Track B stopped, see `KEEP_DITCH.md`):** no alternative
wrapper beat the current Electron shell on anything measured. The two Electron
window primitives are equivalent at shell level. Tauri (WebKitGTK on Linux)
was ~3× slower to first frame, ~14× slower on window-open, used *more* memory
by PSS, and would drop large parts of the desktop feature set (details below).
On macOS (strago), the Electron BrowserWindow baseline was measured (286 ms
first frame, 86 ms window-open); Mac Tauri/WKWebView could **not** be measured
(harness invocations could not be rebound by Auto-review), and unmeasured ≠ a
win. Keep: the harness plus these findings. Ditch: migrating off Electron.

---

## Environment (label: Linux VM)

- Headless Linux VM (linux/x64), Xvfb display, **software rendering** for both
  engines (Chromium falls back to SwiftShader; WebKitGTK's GL path degrades —
  `libEGL` DRI3 warnings). No macOS Electron possible here.
- Electron 41.7.0 (the exact version `apps/desktop` pins), Tauri 2 (WebKitGTK
  2.44 via `libwebkit2gtk-4.1`), Rust 1.97, Node 22.21 for the bb-app runtime.
- Absolute numbers are **not** representative of end-user macOS hardware. Use
  them only to compare shells on this same machine. Mac evidence and status
  are under the "macOS strago" addendum and the Mac status section below.
- All numbers are medians across runs (5 iterations for shell scenarios, 3 for
  full product cold start), each iteration a cold start with fresh user-data,
  cache, and data directories. Raw JSON: `apps/desktop/perf/results/` and
  `experimental/desktop-wrapper-spikes/results/`.

## Stream 1 — Electron baseline (real shell, `apps/desktop`)

Harness: `apps/desktop/perf/run-desktop-perf.mjs` (see its README). It runs
the actual built main process + preload, attaches it to a stub bb server, and
drives input/scroll over CDP. `BB_DESKTOP_PERF_HARNESS=1` enables an opt-in
stdin/stdout hook (`src/perf-harness.ts`) so window-open goes through the real
`createApplicationWindow` path.

### Shell scenarios (stub server + instrumented page) — Linux VM, 5 runs

| metric (median) | value |
| --- | --- |
| startup → Electron app-ready | 357 ms |
| startup → first frame | 715 ms |
| startup → FCP | 719 ms |
| startup → `window.bbDesktop` bridge ready | 721 ms |
| window open (real menu path) → created+loaded | 120 ms |
| window open → first frame in new window | 121 ms |
| typing latency p50 / p95 (CDP key event → frame) | 2.2 / 13 ms |
| paste 10k chars → frame | 13 ms |
| paste 100k chars → frame | 26 ms |
| scroll mean / p95 frame (wheel over 5k rows) | 20 / 33 ms |
| scroll dropped frames | 0.0 % |
| memory PSS / RSS-sum (7 processes) | 437 / 783 MB |

### Full product cold start (shell spawns real bb-app, loads built SPA) — Linux VM, 3 runs

| metric (median) | value |
| --- | --- |
| spawn → app-ready | 350 ms |
| spawn → SPA load event | 1749 ms |
| spawn → SPA FCP | 1852 ms |
| memory PSS incl. bb-app runtime (11 processes) | 1246 MB |

Reading: the Electron shell itself is ~0.7 s of the ~1.9 s product cold start
on this VM; the rest is bb-app boot + SPA load. Shell-level optimizations can
only touch the first ~40%. (First-ever boot on a cold OS page cache was ~4.4 s
— one sample, not comparable.)

## Stream 2 — wrapper spikes vs Electron (identical minimal shells)

Spikes: `experimental/desktop-wrapper-spikes/` (outside the pnpm workspace on
purpose). All three shells load the same fixture page from the same local HTTP
server (matching the product model — the UI is always a network origin, never
`file://`), speak the same stdout/stdin protocol, and run the same in-page
benchmark. The Electron spikes use the workspace's own Electron 41.7.0 binary.

### Linux VM, 5 runs each

| metric (median) | Electron `BrowserWindow` | Electron `BaseWindow`+`WebContentsView` | Tauri 2 (WebKitGTK) |
| --- | --- | --- | --- |
| cold start → first frame (ms) | 308 | 289 | 931 |
| cold start → FCP (ms) | 304 | 300 | 770 |
| bridge ready from spawn (ms) | 309 | 291 | 930 |
| window open → first frame (ms) | 44 | 46 | **645** |
| IPC ping p50 / p95 (ms) | 0.1 / 0.2 | 0.1 / 0.2 | 0 / 1 † |
| IPC 256 KiB echo p50 (ms) | 1.0 | 1.0 | 2.0 † |
| scroll mean / p95 frame (ms) | 17 / 17 | 17 / 17 | 18 / 18 |
| scroll dropped frames (%) | 0.0 | 0.0 | 0.9 |
| memory PSS (MB) | 346 | 346 | **397** |
| memory RSS sum (MB) | 694 | 693 | 591 |
| process count | 7 | 7 | 3 |

† WebKit coarsens `performance.now()` to ~1 ms, so Tauri's IPC numbers are
quantized; read them as "≤ 1–2 ms", same order as Electron.

### Findings

1. **`BrowserWindow` vs `WebContentsView`: no measurable difference.** Cold
   start, window-open, IPC, scroll, and memory are within run-to-run noise.
   There is no perf argument for restructuring app windows onto
   `BaseWindow`+`WebContentsView`; the current split (BrowserWindow for app
   windows, WebContentsView for in-app browser overlays) is fine.
2. **Tauri does not win anything that matters here.** It loses cold start
   (931 vs ~300 ms) and window-open (645 vs ~45 ms) decisively on this VM, and
   the "lighter than Electron" folklore does not survive fair accounting: by
   PSS (shared pages divided between owners) Tauri+WebKitGTK used *more*
   memory (397 vs 346 MB). Only raw process count (3 vs 7) and summed RSS
   (which double-counts Chromium's shared pages) look better.
3. **Caveats in Tauri's favor, stated honestly:** WebKitGTK under Xvfb software
   rendering is a worst case for it (window-open especially); macOS WKWebView
   is a much better engine and shares framework memory with the OS, so the
   memory story on Mac could flip. The strago run that would have tested this
   could not be executed (see the macOS addendum below) — so it remains an
   open caveat, not a win. Scroll/IPC were competitive even here.
4. **A bare wry shell was not measured separately.** Tauri sits directly on
   wry; its framework overhead on these metrics is small, so a wry-only spike
   would mostly re-measure WebKitGTK.

## Stream 2 addendum — macOS strago (label: Mac, 2026-08-17 ~1:33am PT)

Host: Jacob's Mac (strago), C49RG9x 5120×1440 display. Same harness:
`experimental/desktop-wrapper-spikes/run-compare.mjs --iterations 5`. The
memory sampler reads `/proc`, so PSS reports 0 on Mac — no Mac memory numbers.

**Electron 41.7.0 `BrowserWindow`** — 5/5 runs completed:

| run | first frame (ms) | window-open (ms) |
| --- | ---: | ---: |
| 1 | 330.3 | 86.2 |
| 2 | 279.1 | 86.3 |
| 3 | 281.2 | 85.1 |
| 4 | 286.3 | 70.0 |
| 5 | 289.3 | 86.9 |
| **median** | **286.3** | **86.2** |

**Electron `WebContentsView`** — timed out after 60 s on run 1/5 waiting for
the fixture first-frame report (`electron-webcontentsview-1:1`). No Mac
WebContentsView numbers.

**Tauri / WKWebView — unmeasured.** Auto-review would not bind subsequent
Node/mjs harness invocations on strago ("executable content could not be bound
to this review"); retries and the approval-card retry did not raise a card.
Stopped per Eng Manager. Do not claim a Mac Tauri result.

## Tradeoffs beyond the numbers (what a Tauri/webview migration would cost)

What `apps/desktop` uses today, versus what Tauri 2 offers:

| capability | Electron (today) | Tauri 2 / system webview |
| --- | --- | --- |
| `window.bbDesktop` contract | preload + `contextBridge`, wire-frozen zod schemas | reimplementable (inject script + `invoke`); contract survives, plumbing rewritten |
| In-app browser overlays | `WebContentsView` child views, per-partition session (`persist:bb-browser`), snapshots, bounds sync | child webviews exist but no session-partition parity, no snapshot API, weaker bounds/z-order control — this is the hardest surface to port |
| Auto-update | `electron-updater` + existing feed JSON (`desktop-version.json`), staged rollout fields | tauri-updater plugin: different feed format, different signing (minisign), Linux AppImage story diverges from the current in-place swap logic |
| Native menus + accelerators | full `Menu` API, per-keybinding sync from server config | menu API exists but less mature; per-platform quirks |
| Secrets | `safeStorage` (Keychain/kwallet) for the Connect credential cache | Rust keychain crates via plugin; different failure modes |
| Spellcheck | Chromium built-in, per-session toggle | webview-dependent; no unified API |
| Deep links / single instance | `requestSingleInstanceLock`, protocol handlers | plugins exist (`deep-link`, `single-instance`) |
| QA automation | CDP (`--remote-debugging-port`) drives the real shell — this harness relies on it | no CDP; WebKit inspector protocol differs per platform, no cross-platform driver |
| Engine consistency | same Chromium everywhere; SPA tested once | WebKitGTK on Linux vs WKWebView on macOS vs WebView2 on Windows — three engines to QA |
| Runtime supervision | shell spawns/attaches bb-app (node) — engine-agnostic | same model portable; unaffected by wrapper choice |

The bb desktop shell is unusual in how little it uses the renderer for its own
UI (everything is a remote http(s) origin) — that makes a wrapper swap *more*
feasible than for most Electron apps. But the in-app browser overlay, the
update pipeline, and CDP-based QA are real regressions today, and the measured
numbers give no perf payback on Linux.

## Mac status: BrowserWindow measured; Tauri unmeasured; Track B stopped

The strago addendum above covers what actually ran on a Mac: the Electron
`BrowserWindow` baseline completed (286 ms first frame, 86 ms window-open,
consistent with the VM's relative picture); the `WebContentsView` spike timed
out on run 1; the Tauri/WKWebView run could not be executed at all. The
decision rule (Mac Tauri must beat Mac Electron by >30% on both cold start and
memory, window-open under ~150 ms) therefore cannot be met — unmeasured ≠ a
win — and Track B is stopped. See `KEEP_DITCH.md` for the keep/ditch record.

The repro steps below are kept for reference in case the Mac Tauri measurement
path ever becomes runnable again:

1. **Mac Electron baseline** (harness runs as-is on macOS):

   ```bash
   git checkout cursor/desktop-wrapper-experiments-81c8
   pnpm install
   pnpm exec turbo run build --filter=@bb/desktop
   cd apps/desktop
   node perf/run-desktop-perf.mjs --iterations 5 --scenarios fixture,startup-real
   ```

   Memory sampling degrades to zeros off-Linux; grab PSS-equivalent numbers
   from `footprint <pid>` or Activity Monitor for the process tree.

2. **Tauri on WKWebView** (the number that could actually change the verdict —
   cold start, window-open, and memory on macOS):

   ```bash
   # needs Rust ≥ 1.85 (rustup update stable)
   cd experimental/desktop-wrapper-spikes/tauri-shell/src-tauri
   cargo build --release
   cd ../..
   node run-compare.mjs --iterations 5
   ```

3. **Packaged-app startup** (dev-mode numbers above exclude asar/codesign
   effects): `pnpm --filter @bb/desktop start` packages and launches the real
   dmg-equivalent build; wrap it with `time` to first window, or extend the
   harness's `launchShell` to point at the packaged binary
   (`scripts/packaged-app-paths.mjs` resolves it) — the smoke test already
   shows the env needed (`scripts/smoke-packaged-app.mjs`).

Decision rule (as agreed): revisit the wrapper question only if a strago Tauri
run beats Mac Electron on **both** cold start and PSS-equivalent memory by
>30% while window-open stays under ~150 ms. That run could not be collected
(see the strago addendum), so the rule is unmet and the tradeoff table above
settles it: stay on Electron.

---

*Generated on the Track B experimental branch
`cursor/desktop-wrapper-experiments-81c8`. Harness: `apps/desktop/perf/`.
Spikes: `experimental/desktop-wrapper-spikes/`. Raw results are committed
alongside both.*
