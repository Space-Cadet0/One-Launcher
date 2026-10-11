const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  loginStore: (storefrontId) => ipcRenderer.invoke('auth:storefront', storefrontId),
  syncStore: (storefrontId) => ipcRenderer.invoke('store:sync', storefrontId),
  exchangeCode: (storefrontId, code) => ipcRenderer.invoke('store:exchange-code', { storefrontId, code }),
  getSavedTokens: () => ipcRenderer.invoke('store:get-tokens'),
  clearTokens: (storefrontId) => ipcRenderer.invoke('store:clear-tokens', storefrontId),
  scanLocalGames: () => ipcRenderer.invoke('scan:steam-installed'),
  scanSteamAchievements: () => ipcRenderer.invoke('scan:steam-achievements'),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  searchHltb: (title) => ipcRenderer.invoke('hltb:search', title),
  fetchEpicAchievements: (accountId, accessToken) =>
    ipcRenderer.invoke('epic:fetch-achievements', { accountId, accessToken }),
  fetchIgdbCover: (title) => ipcRenderer.invoke('igdb:fetch-cover', title),
});
