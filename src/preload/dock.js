const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  onState: (cb) => ipcRenderer.on('state', (_e, list) => cb(list)),
  focus: (cwd) => ipcRenderer.send('focus', cwd),
  menu: (cwd) => ipcRenderer.send('widget-menu', cwd),
  setY: (map) => ipcRenderer.send('set-card-y', map),
  setOpacity: (v) => ipcRenderer.send('set-opacity', v),
  mouseCapture: (on) => ipcRenderer.send('mouse-capture', on),
});
