const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  onFlash: (cb) => ipcRenderer.on('flash', () => cb()),
  onIdle: (cb) => ipcRenderer.on('idle', (_e, on) => cb(on)),
});
