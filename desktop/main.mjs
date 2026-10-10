import {app,BrowserWindow,Menu,dialog,ipcMain,shell} from 'electron';
import {fork} from 'node:child_process';
import {mkdir,open} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {prepareWorkspace,importLibrary} from './workspace.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
app.setName('EvalDock');
let window,backend,origin,root,quitting=false,importing=false;
if(!app.requestSingleInstanceLock())app.quit();
else {
  app.on('second-instance',()=>{window?.show();window?.focus();});
  app.whenReady().then(start).catch(error=>{dialog.showErrorBox('EvalDock 启动失败',error.message);app.quit();});
}
async function startBackend(){
  const log=await open(path.join(root,'desktop.log'),'a',0o600);
  const child=fork(path.join(root,'desktop/server.mjs'),[],{cwd:root,execPath:process.execPath,env:{...process.env,ELECTRON_RUN_AS_NODE:'1',EVALDOCK_DATASETS_ROOT:path.join(root,'datasets'),PATH:[process.env.PATH,'/opt/homebrew/bin','/usr/local/bin','/usr/bin','/bin'].filter(Boolean).join(':')},stdio:['ignore',log.fd,log.fd,'ipc']});
  await log.close();backend=child;
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{child.kill();reject(Error('本地服务启动超时，请查看数据目录中的 desktop.log'));},30000);
    const fail=()=>{clearTimeout(timer);reject(Error('本地服务启动失败，请查看数据目录中的 desktop.log'));};
    child.once('error',fail);child.once('exit',fail);
    child.on('message',message=>{if(message?.type==='ready'){clearTimeout(timer);child.removeListener('exit',fail);origin='http://127.0.0.1:'+message.port;resolve();}});
  });
  child.on('exit',()=>{if(backend===child&&!quitting){backend=null;dialog.showErrorBox('评测服务已停止','请重新打开 EvalDock。运行记录保存在本机。');}});
}
async function stopBackend(){
  const child=backend;backend=null;if(!child||child.exitCode!==null)return;
  await new Promise(resolve=>{child.once('exit',resolve);child.send('stop');});
}
function trusted(event){
  if(event.sender!==window?.webContents||event.senderFrame!==window.webContents.mainFrame||new URL(event.senderFrame.url).origin!==origin||new URL(event.senderFrame.url).pathname!=='/app.html')throw Error('此操作仅限 EvalDock 主界面');
}
async function start(){
  app.dock?.setIcon(path.join(here,'assets/icon.png'));
  root=path.join(app.getPath('userData'),'workspace');
  await prepareWorkspace(app.isPackaged?path.join(process.resourcesPath,'runtime'):path.join(here,'../artifacts/desktop-runtime'),root);
  await mkdir(path.join(root,'desktop'),{recursive:true});
  await startBackend();
  window=new BrowserWindow({width:1240,height:840,minWidth:940,minHeight:650,title:'EvalDock',backgroundColor:'#f2f4f5',titleBarStyle:'hiddenInset',webPreferences:{preload:path.join(here,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
  window.webContents.setWindowOpenHandler(({url})=>{
    const parsed=new URL(url);
    if(parsed.origin===origin&&parsed.pathname.startsWith('/reports/')){
      const report=new BrowserWindow({width:1050,height:780,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,javascript:false}});report.loadURL(url);
      report.webContents.setWindowOpenHandler(()=>({action:'deny'}));report.webContents.on('will-navigate',event=>event.preventDefault());
    }
    return {action:'deny'};
  });
  window.webContents.on('will-navigate',(event,url)=>{if(new URL(url).origin!==origin)event.preventDefault();});
  window.webContents.session.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {label:'EvalDock',submenu:[{role:'about'},{type:'separator'},{role:'hide'},{role:'hideOthers'},{type:'separator'},{role:'quit'}]},
    {label:'编辑',submenu:[{role:'undo'},{role:'redo'},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'}]},
    {label:'导航',submenu:[{label:'主界面',accelerator:'CmdOrCtrl+1',click:()=>window.loadURL(origin+'/app.html')},{label:'高级工作台',click:()=>window.loadURL(origin+'/')},{label:'打开数据目录',click:()=>shell.openPath(root)}]},
    {label:'窗口',submenu:[{role:'minimize'},{role:'zoom'}]},
  ]));
  ipcMain.handle('desktop:open-data',event=>{trusted(event);return shell.openPath(root);});
  ipcMain.handle('desktop:configure-agents',event=>{trusted(event);return shell.openPath(path.join(root,'config'));});
  ipcMain.handle('desktop:import-library',async event=>{
    trusted(event);if(importing)throw Error('已有导入正在进行');importing=true;
    try{
      const choice=await dialog.showOpenDialog(window,{title:'选择包含 catalog.md 的完整题库文件夹',defaultPath:path.join(root,'datasets'),properties:['openDirectory']});
      if(choice.canceled)return null;
      const status=await fetch(origin+'/api/control/app').then(r=>r.json());
      if(status.errors?.length||status.jobs.some(j=>['STARTING','RUNNING','CANCELLING'].includes(j.state)))throw Error('请等待评测结束，并确认运行记录可读取后再导入');
      await stopBackend();
      let message;
      try{const result=await importLibrary(choice.filePaths[0],root);message=`已导入 ${result.datasets} 个测试集，共 ${result.cases} 题。旧题库已备份。`;}
      catch(error){message='导入失败：'+error.message;}
      await startBackend();await window.loadURL(origin+'/app.html?notice='+encodeURIComponent(message)+'#datasets');
      return null;
    }finally{importing=false;}
  });
  await window.loadURL(origin+'/app.html');
  window.on('close',event=>{if(!quitting){event.preventDefault();app.quit();}});
}
app.on('before-quit',event=>{if(backend&&!quitting){event.preventDefault();quitting=true;stopBackend().finally(()=>app.quit());}});
