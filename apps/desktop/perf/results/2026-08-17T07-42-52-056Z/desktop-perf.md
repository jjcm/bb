# Desktop shell perf (Electron 41.7.0)

- date: 2026-08-17T07:42:41.634Z
- host: linux/x64, display :1
- Collected on a headless Linux VM under Xvfb (software rendering) unless stated otherwise. Absolute numbers are not representative of end-user macOS hardware; compare runs on the same machine only.

## Fixture scenarios (real shell, stub bb server, instrumented page)

| metric (median of runs) | value |
| --- | --- |
| startup → app-ready (ms) | 359 |
| startup → first frame (ms) | 718 |
| startup → FCP (ms) | n/a |
| startup → bbDesktop bridge ready (ms) | 724 |
| window open → created+loaded (ms) | 120 |
| window open → first frame (ms) | 125 |
| typing latency p50 (ms) | -6.18 |
| typing latency p95 (ms) | 9.67 |
| paste 10k chars → frame (ms) | 5.30 |
| paste 100k chars → frame (ms) | 13 |
| scroll mean frame (ms) | 20 |
| scroll p95 frame (ms) | 33 |
| scroll dropped frames (%) | 0.00 |
| memory PSS (MB) | 435 |
| memory RSS sum (MB) | 782 |
| process count | 7.00 |

