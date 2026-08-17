# Desktop shell perf (Electron 41.7.0)

- date: 2026-08-17T07:44:24.169Z
- host: linux/x64, display :1
- Collected on a headless Linux VM under Xvfb (software rendering) unless stated otherwise. Absolute numbers are not representative of end-user macOS hardware; compare runs on the same machine only.

## Fixture scenarios (real shell, stub bb server, instrumented page)

| metric (median of runs) | value |
| --- | --- |
| startup → app-ready (ms) | 357 |
| startup → first frame (ms) | 728 |
| startup → FCP (ms) | 727 |
| startup → bbDesktop bridge ready (ms) | 734 |
| window open → created+loaded (ms) | 121 |
| window open → first frame (ms) | 128 |
| typing latency p50 (ms) | -3.47 |
| typing latency p95 (ms) | 14 |
| paste 10k chars → frame (ms) | 13 |
| paste 100k chars → frame (ms) | 20 |
| scroll mean frame (ms) | 20 |
| scroll p95 frame (ms) | 33 |
| scroll dropped frames (%) | 0.00 |
| memory PSS (MB) | 437 |
| memory RSS sum (MB) | 783 |
| process count | 7.00 |

