const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("vampireCrawlers", {
  rebuildArtCache: () => ipcRenderer.invoke("rebuild-art-cache"),
  onSetupLog: (callback) => ipcRenderer.on("setup-log", (_event, line) => callback(line)),
});
