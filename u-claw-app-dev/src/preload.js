const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('uclaw', {
  getGatewayStatus: () => ipcRenderer.invoke('get-gateway-status'),
  openDashboard: () => ipcRenderer.invoke('open-dashboard'),
  openConfig: () => ipcRenderer.invoke('open-config'),
});
