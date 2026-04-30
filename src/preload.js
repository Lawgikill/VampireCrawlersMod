const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("vampireCrawlers", {
  checkForUpdates: () => ipcRenderer.invoke("check-for-updates"),
  hideSetupPanelForever: () => ipcRenderer.invoke("hide-setup-panel-forever"),
  rebuildArtCache: () => ipcRenderer.invoke("rebuild-art-cache"),
  runStartupSetup: () => ipcRenderer.invoke("run-startup-setup"),
  onSetupLog: (callback) => ipcRenderer.on("setup-log", (_event, line) => callback(line)),
  onSetupProgress: (callback) => ipcRenderer.on("setup-progress", (_event, status) => callback(status)),
  onUpdateStatus: (callback) => ipcRenderer.on("update-status", (_event, status) => callback(status)),
});
