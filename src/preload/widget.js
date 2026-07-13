const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  onState: (cb) => ipcRenderer.on('state', (_e, state) => cb(state)),
  focus: () => ipcRenderer.send('focus'),
  dragStart: () => ipcRenderer.send('drag-start'),
  dragEnd: () => ipcRenderer.send('drag-end'),
  menu: () => ipcRenderer.send('widget-menu'),
});
