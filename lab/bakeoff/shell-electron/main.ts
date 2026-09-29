// lab/bakeoff/shell-electron/main.ts
// Offscreen BrowserWindow so it runs headless under Xvfb. Loads the shared
// dist/index.html (staged beside this shell by the matrix), receives the sink
// payload over IPC, writes it to BAKEOFF_SINK, then STAYS ALIVE so the matrix can
// snapshot the AT-SPI tree before killing it (a11y_exposure gate).
import { app, BrowserWindow, ipcMain } from "electron";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

app.disableHardwareAcceleration();
// Name the app so the AT-SPI probe (match "bakeoff") can find it on the bus, and
// force Chromium to build the accessibility tree (it is otherwise lazy/headless).
app.setName("bakeoff");
app.commandLine.appendSwitch("force-renderer-accessibility");

const SINK = process.env.BAKEOFF_SINK ?? join(process.cwd(), "sink.json");
const INDEX = process.env.BAKEOFF_INDEX ?? join(__dirname, "dist", "index.html");

let sunk = false;
function writeSink(payload: unknown): void {
  if (sunk) return;
  sunk = true;
  writeFileSync(SINK, JSON.stringify(payload));
}

ipcMain.on("bakeoff:sink", (_e, payload) => {
  // Persist the run, then linger so the matrix can probe AT-SPI while the window
  // is still up. The matrix kills us once it has the snapshot; self-quit is a
  // safety net if it never does.
  writeSink(payload);
  setTimeout(() => app.quit(), 30_000);
});

app.whenReady().then(() => {
  app.setAccessibilitySupportEnabled(true);
  const win = new BrowserWindow({
    width: 900,
    height: 900,
    show: false,
    webPreferences: {
      offscreen: true,
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.webContents.setFrameRate(60);
  win.loadFile(INDEX);
  // Safety net: never hang the matrix. Fail closed 5 minutes after the page is
  // expected to be done — which, during a soak, is 5 minutes AFTER the soak
  // ends. This was a flat 5 minutes, written before the soak existed, so every
  // soak longer than that was killed mid-run and recorded as a "timeout"
  // payload. That is a harness limit; it says nothing about the candidate.
  const SOAK_MS = Number(process.env.BAKEOFF_SOAK_MS ?? "0");
  const watchdogMs = (Number.isFinite(SOAK_MS) && SOAK_MS > 0 ? SOAK_MS : 0) + 5 * 60_000;
  setTimeout(() => {
    writeSink({
      candidate: "electron",
      fixture: "timeout",
      seed: "",
      samples: [],
      coldStartMs: -1,
      warmStartMs: -1,
    });
    app.quit();
  }, watchdogMs);
});

app.on("window-all-closed", () => app.quit());
