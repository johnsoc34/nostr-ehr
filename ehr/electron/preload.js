const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  getConfig: () => ipcRenderer.invoke("get-config"),
  saveConfig: (config) => ipcRenderer.invoke("save-config", config),
  setupComplete: () => ipcRenderer.invoke("setup-complete"),
  openSettings: () => ipcRenderer.invoke("open-settings"),
  getVersion: () => ipcRenderer.invoke("get-app-version"),
  getDataPath: () => ipcRenderer.invoke("get-data-path"),
});