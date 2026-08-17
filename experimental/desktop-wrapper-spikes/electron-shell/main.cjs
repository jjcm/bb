// Experimental minimal Electron shell for the bb desktop wrapper comparison.
//
// SPIKE_MODE selects the window primitive:
//   - "browserwindow"    → BrowserWindow (what apps/desktop uses for app windows)
//   - "webcontentsview"  → BaseWindow + WebContentsView (what apps/desktop uses
//                          for in-app browser overlays)
// Everything else — preload, webPreferences, fixture URL, IPC handler, stdout
// protocol — is identical between the modes, so any measured difference is the
// window primitive itself.

"use strict";

const mainStartMs = Date.now();

const path = require("node:path");
const readline = require("node:readline");
const {
  app,
  BaseWindow,
  BrowserWindow,
  ipcMain,
  WebContentsView,
} = require("electron");

function emit(kind) {
  process.stdout.write(`${JSON.stringify({ perf: kind, tMs: Date.now() })}\n`);
}

const mode = process.env.SPIKE_MODE ?? "browserwindow";
if (mode !== "browserwindow" && mode !== "webcontentsview") {
  throw new Error(`unknown SPIKE_MODE: ${mode}`);
}
const fixtureBase = process.env.SPIKE_FIXTURE_URL;
if (typeof fixtureBase !== "string" || fixtureBase.length === 0) {
  throw new Error("SPIKE_FIXTURE_URL must point at the fixture server");
}

const webPreferences = {
  contextIsolation: true,
  nodeIntegration: false,
  preload: path.join(__dirname, "preload.cjs"),
  sandbox: true,
};

function fixtureUrl(win) {
  const url = new URL(fixtureBase);
  url.searchParams.set("win", String(win));
  return url.toString();
}

function openWindow(win) {
  if (mode === "browserwindow") {
    const browserWindow = new BrowserWindow({
      height: 800,
      show: true,
      webPreferences,
      width: 1280,
    });
    void browserWindow.loadURL(fixtureUrl(win));
  } else {
    const baseWindow = new BaseWindow({ height: 800, show: true, width: 1280 });
    const view = new WebContentsView({ webPreferences });
    baseWindow.contentView.addChildView(view);
    const fit = () => {
      const bounds = baseWindow.getContentBounds();
      view.setBounds({ height: bounds.height, width: bounds.width, x: 0, y: 0 });
    };
    fit();
    baseWindow.on("resize", fit);
    void view.webContents.loadURL(fixtureUrl(win));
  }
  emit(win === 1 ? "window-created" : "second-window-created");
}

ipcMain.handle("spike:ping", (_event, payload) => payload ?? null);

emit("main-start-late"); // after requiring electron; see mainStartMs below
process.stdout.write(
  `${JSON.stringify({ perf: "main-start", tMs: mainStartMs })}\n`,
);

void app.whenReady().then(() => {
  emit("app-ready");
  openWindow(1);

  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const command = line.trim();
    if (command === "open-window") {
      emit("open-window-requested");
      openWindow(2);
    } else if (command === "quit") {
      app.quit();
    }
  });
});

app.on("window-all-closed", () => {
  app.quit();
});
