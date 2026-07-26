const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { existsSync, renameSync } = require("node:fs");
const path = require("node:path");

const execFileAsync = promisify(execFile);
const bridgeUrl = process.env.VOICE_BRIDGE_URL || "http://127.0.0.1:4173";
const routeScript = path.resolve(__dirname, "..", "tools", "route-client-audio.sh");
let routingTimer = null;

app.disableHardwareAcceleration();
const appData = app.getPath("appData");
const canonicalUserData = path.join(appData, "atlas-agent");
for (const legacyName of ["atlas-live-agentic-support", "atsla-support-live-agent", "atlas-live-agent-support"]) {
  const legacyUserData = path.join(appData, legacyName);
  if (!existsSync(canonicalUserData) && existsSync(legacyUserData)) {
    try { renameSync(legacyUserData, canonicalUserData); } catch {}
  }
}
app.setName("atlas-agent");
app.setPath("userData", canonicalUserData);

async function request(pathname, options = {}) {
  const response = await fetch(`${bridgeUrl}${pathname}`, options);
  if (!response.ok) throw new Error(`ATLAS | Live Agentic Support returned HTTP ${response.status}.`);
  return response.json();
}

async function wireClientAudio(inputMode) {
  const args = [routeScript, "wire"];
  if (inputMode) args.push(inputMode);
  const { stdout } = await execFileAsync("bash", args);
  return JSON.parse(stdout);
}

function createWindow() {
  const window = new BrowserWindow({
    title: "ATLAS | Live Agentic Support",
    width: 1800,
    height: 1120,
    minWidth: 1280,
    minHeight: 800,
    autoHideMenuBar: true,
    backgroundColor: "#03072b",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });
  window.setMenuBarVisibility(false);

  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  const startingPage = `data:text/html,${encodeURIComponent(`<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;background:#f4f1e8;color:#17221f;font-family:sans-serif;display:grid;place-items:center;height:100vh}.box{text-align:center}.dot{width:12px;height:12px;margin:0 auto 18px;border-radius:50%;background:#1d5546;box-shadow:0 0 0 7px #dce8c9}h1{font-family:serif;font-size:30px;margin:0 0 8px}p{color:#607069}</style></head><body><div class="box"><div class="dot"></div><h1>ATLAS | Live Agentic Support</h1><p>Starting local meeting services...</p></div></body></html>`)}`;
  window.loadURL(startingPage).then(() => loadVoiceBridge(window));
}

async function loadVoiceBridge(window) {
  let lastError = new Error("ATLAS | Live Agentic Support API did not respond.");
  for (let attempt = 0; attempt < 60 && !window.isDestroyed(); attempt += 1) {
    try {
      const response = await fetch(`${bridgeUrl}/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) {
        await window.loadURL(bridgeUrl);
        return;
      }
      lastError = new Error(`Voice Bridge health returned HTTP ${response.status}.`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!window.isDestroyed()) dialog.showErrorBox("ATLAS | Live Agentic Support could not start", lastError.message);
}

ipcMain.handle("voiceBridge:wireClientAudio", (_event, inputMode) => wireClientAudio(inputMode));
ipcMain.handle("voiceBridge:clientAudioStatus", async () => {
  const { stdout } = await execFileAsync("bash", [routeScript, "status"]);
  return JSON.parse(stdout);
});
ipcMain.handle("voiceBridge:stopSpeech", () => request("/v1/stop", { method: "POST" }));
ipcMain.handle("voiceBridge:chooseClientWorkspace", async () => {
  const result = await dialog.showOpenDialog({ title: "Choose client workspace", properties: ["openDirectory", "createDirectory"] });
  return result.canceled ? "" : result.filePaths[0];
});
ipcMain.handle("voiceBridge:openPath", async (_event, filePath) => {
  if (typeof filePath !== "string" || !filePath) throw new Error("A file path is required.");
  const error = await shell.openPath(filePath);
  if (error) throw new Error(error);
  return { opened: filePath };
});
ipcMain.on("voiceBridge:rendererReady", () => {
  console.log("[Desktop] operator console renderer ready");
});

app.whenReady().then(() => {
  createWindow();
  wireClientAudio().catch(() => {});
  routingTimer = setInterval(() => wireClientAudio().catch(() => {}), 2000);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  if (routingTimer) clearInterval(routingTimer);
});