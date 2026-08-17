# Desktop shell perf (Electron 41.7.0)

- date: 2026-08-17T07:55:29.334Z
- host: linux/x64, display :1
- Collected on a headless Linux VM under Xvfb (software rendering) unless stated otherwise. Absolute numbers are not representative of end-user macOS hardware; compare runs on the same machine only.

## Fixture scenarios (real shell, stub bb server, instrumented page)

| metric (median of runs) | value |
| --- | --- |
| startup → app-ready (ms) | 357 |
| startup → first frame (ms) | 715 |
| startup → FCP (ms) | 719 |
| startup → bbDesktop bridge ready (ms) | 721 |
| window open → created+loaded (ms) | 120 |
| window open → first frame (ms) | 121 |
| typing latency p50 (ms) | 2.20 |
| typing latency p95 (ms) | 13 |
| paste 10k chars → frame (ms) | 13 |
| paste 100k chars → frame (ms) | 26 |
| scroll mean frame (ms) | 20 |
| scroll p95 frame (ms) | 33 |
| scroll dropped frames (%) | 0.00 |
| memory PSS (MB) | 437 |
| memory RSS sum (MB) | 783 |
| process count | 7.00 |

## Full product cold start (shell spawns bb-app, loads built SPA)

| metric (median of runs) | value |
| --- | --- |
| spawn → app-ready (ms) | 350 |
| spawn → SPA load event (ms) | 1749 |
| spawn → SPA FCP (ms) | 1852 |
| memory PSS incl. bb-app (MB) | 1246 |
| process count | 11 |

