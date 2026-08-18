# Desktop wrapper spikes (experimental)

Isolated spikes comparing shells that could host the bb desktop app, measured
against one identical fixture page served over local HTTP (the same
network-origin model the real shell uses — it always loads the UI over
http(s), never `file://`).

**This directory is deliberately outside the pnpm workspace.** Nothing in the
product depends on it, and it must stay that way unless a wrapper wins on
measured numbers and a real migration is decided. See `WRAPPER_COMPARE.md` at
the repo root for findings.

## Shells

| id | what it is |
| --- | --- |
| `electron-browserwindow` | Minimal Electron shell, `BrowserWindow` (what `apps/desktop` uses for app windows). Reuses the workspace's Electron binary, so it is version-identical to the product shell. |
| `electron-webcontentsview` | Same shell, `BaseWindow` + `WebContentsView` (what `apps/desktop` uses for in-app browser overlays). Only the window primitive differs. |
| `tauri` | Tauri 2 app (`tauri-shell/`), system WebKitGTK on Linux / WKWebView on macOS. Loads the same remote-origin fixture; `ping` is exposed through Tauri's ACL (`capabilities/default.json` + `permissions/ping.toml`). |

All shells speak the same tiny protocol: JSON milestone lines on stdout
(`main-start`, `app-ready`, `window-created`, …), `open-window` / `quit`
commands on stdin, and the fixture page reports paint/IPC/scroll numbers to
the fixture server over HTTP in `Date.now()`-calibrated epoch ms.

## Metrics

- cold start: spawn → first rAF frame (cross-engine comparable) and → FCP
  (where Paint Timing is supported), plus bridge-ready
- window open: stdin command → second window first frame
- IPC round trip: 8-byte and 256 KiB echo, p50/p95 (Electron
  `ipcRenderer.invoke` vs Tauri `invoke`)
- scroll: rAF frame cadence during a programmatic scroll of a 5k-row list
  (engine layout/paint cost on identical content; OS input delivery cannot be
  driven identically across shells)
- memory: PSS/RSS summed over the process tree from `/proc` after a settle
  (Linux only; degrades to zeros elsewhere)

## Running

```bash
# Electron spikes need the workspace install (pnpm install at repo root).
# Tauri needs Rust ≥ 1.85 and, on Linux, libwebkit2gtk-4.1-dev + libgtk-3-dev.
cd experimental/desktop-wrapper-spikes/tauri-shell/src-tauri && cargo build --release

cd experimental/desktop-wrapper-spikes
node run-compare.mjs --iterations 5
# subset:
node run-compare.mjs --iterations 5 --shells electron-browserwindow,tauri
```

Results land in `results/<timestamp>/compare.{json,md}`, labeled with the host
environment.

## Caveats — read before trusting a number

- A Linux VM under Xvfb uses software rendering for both engines. Chromium
  ships SwiftShader and handles that gracefully; WebKitGTK's GL path degrades
  differently (see `libEGL` warnings). macOS (WKWebView, GPU composited) is a
  different engine entirely — Linux Tauri numbers do not transfer.
- The spikes measure shell overhead, not bb. None of them implement the
  desktop-contract surface (`window.bbDesktop`, in-app browser overlays,
  auto-update, native menus, deep links); see WRAPPER_COMPARE.md for the API
  coverage comparison.
- The Electron spikes reuse the already-warm OS page cache for the Electron
  binary like the Tauri binary run does; both are "warm disk, cold process"
  numbers.
