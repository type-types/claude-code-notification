const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  onFlash: (cb) => ipcRenderer.on('flash', (_e, kind) => cb(kind)),
  onIdle: (cb) => ipcRenderer.on('idle', (_e, on) => cb(on)),
});
