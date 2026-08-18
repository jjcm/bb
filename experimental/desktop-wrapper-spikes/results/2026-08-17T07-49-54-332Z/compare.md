| metric (median of runs) | Electron 41.7.0 BrowserWindow | Electron 41.7.0 BaseWindow+WebContentsView | Tauri 2 (WebKitGTK) |
| --- | --- | --- | --- |
| cold start → first frame (ms) | 308 | 289 | 931 |
| cold start → FCP (ms) | 304 | 300 | 770 |
| bridge ready from spawn (ms) | 309 | 291 | 930 |
| window open → first frame (ms) | 44 | 46 | 645 |
| IPC ping p50 (ms) | 0.10 | 0.10 | 0.00 |
| IPC ping p95 (ms) | 0.20 | 0.20 | 1.00 |
| IPC 256KiB echo p50 (ms) | 1.00 | 1.00 | 2.00 |
| scroll mean frame (ms) | 17 | 17 | 18 |
| scroll p95 frame (ms) | 17 | 17 | 18 |
| scroll dropped frames (%) | 0.00 | 0.00 | 0.91 |
| memory PSS (MB) | 346 | 346 | 397 |
| memory RSS sum (MB) | 694 | 693 | 591 |
| process count | 7.00 | 7.00 | 3.00 |
