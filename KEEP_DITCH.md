# Keep / Ditch

## Track B — Electron perf harness + alternative desktop wrappers

**KEEP:** the Electron perf harness (`apps/desktop/perf/` + the spike
comparison tooling in `experimental/desktop-wrapper-spikes/`).
**DITCH:** migrating the desktop shell off Electron.
**Status:** Track B stopped. PR [#2](https://github.com/jjcm/bb/pull/2) stays
open as the record; never merge without review.

### Why

No alternative wrapper beat Electron on anything we could measure.
`WebContentsView` is a wash with `BrowserWindow`. Tauri was slower and not
lighter on Linux. Mac Tauri/WKWebView was **not measured** (the strago Node
harness could not be rebound by Auto-review), and unmeasured ≠ a win.

The pre-agreed decision rule was: Mac Tauri must beat Mac Electron by >30% on
**both** cold start **and** memory, with window-open staying under ~150 ms —
or Track B stops. Since the Mac Tauri number could not be collected, the rule
is not met, and the Linux evidence points the other way. Stop Track B.

### Evidence — Linux VM

Headless linux/x64, Xvfb, software rendering. Electron 41.7.0 vs Tauri 2 on
WebKitGTK. Medians of 5 spike iterations / 3 full-product runs. Raw JSON is
committed under `experimental/desktop-wrapper-spikes/results/` and
`apps/desktop/perf/results/`.

Spikes against an identical fixture page (same local HTTP origin, same
protocol, same benchmark):

| metric (median) | Electron BrowserWindow | Electron WebContentsView | Tauri 2 (WebKitGTK) |
| --- | ---: | ---: | ---: |
| cold start → first frame (ms) | 308 | 289 | 931 |
| cold start → FCP (ms) | 304 | 300 | 770 |
| window open → first frame (ms) | 44 | 46 | 645 |
| memory PSS (MB) | 346 | 346 | 397 |
| memory RSS sum (MB) | 694 | 693 | 591 |

Tauri was ~3× slower to first frame, ~14× slower on window-open, and higher by
PSS (the fair multi-process memory metric; the lower RSS sum double-counts
Chromium's shared pages). Caveat, stated honestly: WebKitGTK under Xvfb
software rendering is a worst case for Tauri, and it is not Mac.

Real Electron shell (`apps/desktop`) via the harness against a stub bb server:
startup → first frame 715 ms, window-open 121 ms, PSS 437 MB.

### Evidence — macOS strago (2026-08-17 ~1:33am PT)

Host: Jacob's Mac, C49RG9x 5120×1440 display. Harness:
`experimental/desktop-wrapper-spikes/run-compare.mjs --iterations 5`. PSS
reads as 0 on Mac (the sampler reads `/proc`), so no Mac memory numbers.

Electron 41.7.0 BrowserWindow, 5/5 runs completed:

| run | first frame (ms) | window-open (ms) |
| --- | ---: | ---: |
| 1 | 330.3 | 86.2 |
| 2 | 279.1 | 86.3 |
| 3 | 281.2 | 85.1 |
| 4 | 286.3 | 70.0 |
| 5 | 289.3 | 86.9 |
| **median** | **286.3** | **86.2** |

Electron WebContentsView: timed out after 60 s on run 1/5 waiting for the
fixture first-frame report (`electron-webcontentsview-1:1`). No Mac
WebContentsView numbers.

Tauri / WKWebView: **unmeasured.** Auto-review would not bind subsequent
Node/mjs harness invocations on strago ("executable content could not be bound
to this review"); retries and the approval-card retry did not raise a card.
Stopped per Eng Manager. Do not claim a Mac Tauri result.

### VM vs Mac split

- Linux VM: full comparison collected (both Electron variants + Tauri), but
  software rendering and WebKitGTK make it a lower bound for Tauri.
- Mac: Electron BrowserWindow baseline collected (286 ms first frame, 86 ms
  window-open — consistent with the VM's relative picture); WebContentsView
  and Tauri not collected. The one number that could have changed the verdict
  (Tauri on WKWebView) does not exist, and the burden of proof was on the
  challenger.

### Tradeoffs that stand regardless of the numbers

A migration off Electron would additionally cost (see the table in
`WRAPPER_COMPARE.md` for detail): in-app browser overlay parity
(`WebContentsView` + partitioned sessions + snapshots), the existing
`electron-updater` feed/rollout pipeline, CDP-driven QA (which this very
harness depends on), `safeStorage`-backed Connect credentials, Chromium
spellcheck, and single-engine QA instead of WebKitGTK/WKWebView/WebView2.

### What we keep using

- `apps/desktop/perf/run-desktop-perf.mjs` — reproducible startup /
  window-open / input / scroll / memory measurements of the real shell; useful
  for regression-checking Electron upgrades and shell changes.
- `experimental/desktop-wrapper-spikes/` — kept as-is (not deleted) so the
  comparison can be re-run if the decision rule's inputs ever change (e.g. a
  working Mac Tauri measurement path).
