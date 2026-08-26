const { contextBridge, ipcRenderer } = require('electron');

const isActivationOnlyMode = process.argv.includes('--activation-only')
  || process.env.UCLAW_ACTIVATION_ONLY === '1';

if (isActivationOnlyMode) {
  contextBridge.exposeInMainWorld('uclawActivation', {
    getPreflight: () => ipcRenderer.invoke('activation:get-preflight'),
    submitActivation: (payload) => ipcRenderer.invoke('activation:submit', payload),
    windowAction: (action) => ipcRenderer.invoke('activation:window-action', action),
  });
} else {
  contextBridge.exposeInMainWorld('uclaw', {
    getGatewayStatus: () => ipcRenderer.invoke('get-gateway-status'),
    openDashboard: () => ipcRenderer.invoke('open-dashboard'),
    openConfig: () => ipcRenderer.invoke('open-config'),
  });
}
