const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("vampireCrawlers", {
  checkForUpdates: () => ipcRenderer.invoke("check-for-updates"),
  hideSetupPanelForever: () => ipcRenderer.invoke("hide-setup-panel-forever"),
  rebuildArtCache: () => ipcRenderer.invoke("rebuild-art-cache"),
  onSetupLog: (callback) => ipcRenderer.on("setup-log", (_event, line) => callback(line)),
  onUpdateStatus: (callback) => ipcRenderer.on("update-status", (_event, status) => callback(status)),
});
