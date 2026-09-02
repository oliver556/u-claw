const { contextBridge, ipcRenderer } = require('electron');

const isActivationOnlyMode = process.argv.includes('--activation-only')
  || process.env.UCLAW_ACTIVATION_ONLY === '1';

if (isActivationOnlyMode) {
  contextBridge.exposeInMainWorld('uclawActivation', {
    getPreflight: () => ipcRenderer.invoke('activation:get-preflight'),
    sendSMS: (payload) => ipcRenderer.invoke('activation:send-sms', payload),
    submitActivation: (payload) => ipcRenderer.invoke('activation:submit', payload),
    launchMain: () => ipcRenderer.invoke('activation:launch-main'),
    completeActivation: () => ipcRenderer.invoke('activation:complete'),
    windowAction: (action) => ipcRenderer.invoke('activation:window-action', action),
  });
} else {
  contextBridge.exposeInMainWorld('uclaw', {
    getGatewayStatus: () => ipcRenderer.invoke('get-gateway-status'),
    openDashboard: () => ipcRenderer.invoke('open-dashboard'),
    openConfig: () => ipcRenderer.invoke('open-config'),
    getModelUsageSummary: () => ipcRenderer.invoke('uclaw:get-model-usage-summary'),
    getModelCatalog: () => ipcRenderer.invoke('uclaw:get-model-catalog'),
    refreshModelCatalog: () => ipcRenderer.invoke('uclaw:refresh-model-catalog'),
    getRechargePlans: () => ipcRenderer.invoke('uclaw:get-recharge-plans'),
    getRechargeProviders: () => ipcRenderer.invoke('uclaw:get-recharge-providers'),
    getRechargeOrders: () => ipcRenderer.invoke('uclaw:get-recharge-orders'),
    getRechargeOrder: (orderNo) => ipcRenderer.invoke('uclaw:get-recharge-order', orderNo),
    rechargeModelQuota: (payload) => ipcRenderer.invoke('uclaw:recharge-model-quota', payload),
    generateEcommerceImages: (payload) => ipcRenderer.invoke('uclaw:ecommerce-generate-images', payload),
    openEcommerceLocalPath: (payload) => ipcRenderer.invoke('uclaw:ecommerce-open-local-path', payload),
    writeDebuggerLog: (payload) => ipcRenderer.invoke('uclaw:write-debugger-log', payload),
    onEcommerceImageProgress: (callback) => {
      if (typeof callback !== 'function') return () => {};
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('uclaw:ecommerce-image-progress', listener);
      return () => ipcRenderer.removeListener('uclaw:ecommerce-image-progress', listener);
    },
    materializeEcommerceImage: (payload) => ipcRenderer.invoke('uclaw:ecommerce-materialize-image', payload),
  });
}
