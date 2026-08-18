"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("spikeBridge", {
  ping: (payload) => ipcRenderer.invoke("spike:ping", payload),
});
