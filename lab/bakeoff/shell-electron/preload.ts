// lab/bakeoff/shell-electron/preload.ts
// Installs the two shims run.js expects, then lets index.html load run.js.
// contextBridge keeps the renderer sandboxed: it only sees __bakeoffSink and
// the fixture URL, not ipcRenderer.
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("__bakeoffFixtureUrl", "./scene-data.json");
contextBridge.exposeInMainWorld("__bakeoffCandidate", "electron");
contextBridge.exposeInMainWorld("__bakeoffSeed", process.env.BAKEOFF_SEED ?? "bakeoff-v1");
contextBridge.exposeInMainWorld("__bakeoffSink", (payload: unknown) => {
  ipcRenderer.send("bakeoff:sink", payload);
});
