const { contextBridge, ipcRenderer } = require('electron');

const isActivationOnlyMode = process.argv.includes('--activation-only')
  || process.env.UCLAW_ACTIVATION_ONLY === '1';

if (isActivationOnlyMode) {
  contextBridge.exposeInMainWorld('uclawActivation', {
    getPreflight: () => ipcRenderer.invoke('activation:get-preflight'),
    sendSMS: (payload) => ipcRenderer.invoke('activation:send-sms', payload),
    submitActivation: (payload) => ipcRenderer.invoke('activation:submit', payload),
    windowAction: (action) => ipcRenderer.invoke('activation:window-action', action),
  });
} else {
  contextBridge.exposeInMainWorld('uclaw', {
    getGatewayStatus: () => ipcRenderer.invoke('get-gateway-status'),
    openDashboard: () => ipcRenderer.invoke('open-dashboard'),
    openConfig: () => ipcRenderer.invoke('open-config'),
    getModelUsageSummary: () => ipcRenderer.invoke('uclaw:get-model-usage-summary'),
    getRechargePlans: () => ipcRenderer.invoke('uclaw:get-recharge-plans'),
    getRechargeOrders: () => ipcRenderer.invoke('uclaw:get-recharge-orders'),
    rechargeModelQuota: (payload) => ipcRenderer.invoke('uclaw:recharge-model-quota', payload),
  });
}
