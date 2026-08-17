// Experimental Tauri 2 shell spike for the bb desktop wrapper comparison.
//
// Loads the shared fixture page from SPIKE_FIXTURE_URL (a local HTTP server run
// by the compare orchestrator), answers `ping` IPC round trips, and reports
// lifecycle milestones as JSON lines on stdout so the orchestrator can align
// them with page-side timings. `open-window` on stdin opens a second window,
// mirroring the Electron spike shells.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{BufRead, Write};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, WebviewUrl, WebviewWindowBuilder};

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time before epoch")
        .as_millis()
}

fn emit(kind: &str) {
    let mut stdout = std::io::stdout().lock();
    // Keep the line shape identical to the Electron spike shells.
    writeln!(stdout, "{{\"perf\":\"{}\",\"tMs\":{}}}", kind, now_ms()).ok();
    stdout.flush().ok();
}

fn fixture_url(win: u32) -> tauri::Url {
    let base = std::env::var("SPIKE_FIXTURE_URL")
        .expect("SPIKE_FIXTURE_URL must point at the fixture server");
    let sep = if base.contains('?') { '&' } else { '?' };
    format!("{base}{sep}win={win}")
        .parse()
        .expect("SPIKE_FIXTURE_URL must be a valid URL")
}

fn open_window(app: &AppHandle, label: &str, win: u32) {
    let url = fixture_url(win);
    WebviewWindowBuilder::new(app, label, WebviewUrl::External(url))
        .title("spike-tauri-shell")
        .inner_size(1280.0, 800.0)
        .build()
        .expect("window build failed");
    emit(if win == 1 {
        "window-created"
    } else {
        "second-window-created"
    });
}

#[tauri::command]
fn ping(payload: Option<String>) -> Option<String> {
    payload
}

fn main() {
    emit("main-start");
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![ping])
        .setup(|app| {
            emit("app-ready");
            open_window(app.handle(), "main", 1);

            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let stdin = std::io::stdin();
                for line in stdin.lock().lines() {
                    let Ok(line) = line else { break };
                    match line.trim() {
                        "open-window" => {
                            emit("open-window-requested");
                            let handle = handle.clone();
                            // Window creation must happen on the main thread.
                            handle
                                .clone()
                                .run_on_main_thread(move || {
                                    open_window(&handle, "second", 2);
                                })
                                .ok();
                        }
                        "quit" => {
                            handle.exit(0);
                        }
                        _ => {}
                    }
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
