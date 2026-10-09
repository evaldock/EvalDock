const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('evaldockDesktop',Object.freeze({
  importLibrary:()=>ipcRenderer.invoke('desktop:import-library'),
  openData:()=>ipcRenderer.invoke('desktop:open-data'),
  configureAgents:()=>ipcRenderer.invoke('desktop:configure-agents'),
}));
