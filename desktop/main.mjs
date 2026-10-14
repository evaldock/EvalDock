import {app,BrowserWindow,Menu,dialog,ipcMain,shell} from 'electron';
import {fork,spawnSync} from 'node:child_process';
import {mkdir,open} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {prepareWorkspace,importLibrary,isBundledLibrary} from './workspace.mjs';
import {importLibraryArchive} from './library-archive.mjs';
import {DesktopUpdates,updateEligible} from './updates.mjs';
import updaterPackage from 'electron-updater';
const here=path.dirname(fileURLToPath(import.meta.url));
app.setName('EvalDock');
let window,backend,origin,root,updates,quitting=false,importing=false,automaticLibrary=false;
if(!app.requestSingleInstanceLock())app.quit();
else {
  app.on('second-instance',()=>{window?.show();window?.focus();});
  app.whenReady().then(start).catch(error=>{if(!quitting)dialog.showErrorBox('EvalDock 启动失败',error.message);app.quit();});
}
async function startBackend(){
  const log=await open(path.join(root,'desktop.log'),'a',0o600);
  const child=fork(path.join(root,'desktop/server.mjs'),[],{cwd:root,execPath:process.execPath,env:{...process.env,ELECTRON_RUN_AS_NODE:'1',EVALDOCK_AUTO_DATASETS:automaticLibrary?'1':'0',EVALDOCK_DATASETS_ROOT:path.join(root,'datasets'),PATH:[process.env.PATH,'/opt/homebrew/bin','/usr/local/bin','/usr/bin','/bin'].filter(Boolean).join(':')},stdio:['ignore',log.fd,log.fd,'ipc']});
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
async function updateMenu(){
  const status=await updates.check();
  if(status.state==='AVAILABLE'){
    const choice=await dialog.showMessageBox(window,{message:'发现 EvalDock '+status.availableVersion,detail:'下载完成后可以安装更新。配置、题库和评测记录保留在本机。',buttons:['下载更新','稍后'],cancelId:1});
    if(choice.response===0){await updates.download();return updateMenu();}
  }else if(status.state==='READY'){
    const choice=await dialog.showMessageBox(window,{message:'更新已下载',detail:'安装将重启 EvalDock。请先结束评测、题库准备和导入。',buttons:['安装并重启','稍后'],cancelId:1});
    if(choice.response===0)try{await updates.install();}catch(error){await dialog.showMessageBox(window,{message:error.message});}
  }else await dialog.showMessageBox(window,{message:status.state==='CURRENT'?'当前已是最新版本':status.state==='DOWNLOADING'?'更新下载中':status.state==='CHECKING'?'正在检查更新':status.reason??status.error??'请稍后重试',detail:status.state==='DOWNLOADING'?Math.round(status.percent)+'%':''});
}
async function start(){
  app.dock?.setIcon(path.join(here,'assets/icon.png'));
  root=path.join(app.getPath('userData'),'workspace');
  const source=app.isPackaged?path.join(process.resourcesPath,'runtime'):path.join(here,'../artifacts/desktop-runtime');
  await prepareWorkspace(source,root);
  automaticLibrary=await isBundledLibrary(source,root);
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
  let signature='';
  if(app.isPackaged){
    const bundle=path.dirname(path.dirname(path.dirname(process.execPath)));
    const verified=spawnSync('/usr/bin/codesign',['--verify','--deep','--strict',bundle],{encoding:'utf8'});
    if(verified.status===0){const described=spawnSync('/usr/bin/codesign',['-dv','--verbose=4',bundle],{encoding:'utf8'});if(described.status===0)signature=described.stderr;}
  }
  updates=new DesktopUpdates({updater:updaterPackage.autoUpdater,enabled:updateEligible({packaged:app.isPackaged,platform:process.platform,signature}),version:app.getVersion(),canInstall:async()=>{
    if(importing)return false;
    const [status,library]=await Promise.all([fetch(origin+'/api/control/app').then(r=>r.json()),fetch(origin+'/api/control/library').then(r=>r.json())]);
    return !status.busy&&!status.errors?.length&&!status.jobs.some(j=>['STARTING','RUNNING','CANCELLING'].includes(j.state))&&library.selection?.state!=='PREPARING'&&!['DOWNLOADING','INSTALLING'].includes(library.state)&&!['DOWNLOADING','INSTALLING'].includes(library.download?.state);
  },beforeInstall:async()=>{await stopBackend();quitting=true;}});
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {label:'EvalDock',submenu:[{role:'about'},{label:'检查更新…',click:()=>void updateMenu().catch(()=>dialog.showErrorBox('更新失败','请稍后重试。'))},{label:'查看发布版本',click:()=>shell.openExternal('https://github.com/evaldock/EvalDock/releases')},{type:'separator'},{role:'hide'},{role:'hideOthers'},{type:'separator'},{role:'quit'}]},
    {label:'编辑',submenu:[{role:'undo'},{role:'redo'},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'}]},
    {label:'导航',submenu:[{label:'主界面',accelerator:'CmdOrCtrl+1',click:()=>window.loadURL(origin+'/app.html')},{label:'高级工作台',click:()=>window.loadURL(origin+'/')},{label:'打开数据目录',click:()=>shell.openPath(root)}]},
    {label:'窗口',submenu:[{role:'minimize'},{role:'zoom'}]},
  ]));
  ipcMain.handle('desktop:open-data',event=>{trusted(event);return shell.openPath(root);});
  ipcMain.handle('desktop:configure-agents',event=>{trusted(event);return shell.openPath(path.join(root,'config'));});
  ipcMain.handle('desktop:import-library',async event=>{
    trusted(event);if(importing)throw Error('已有导入正在进行');importing=true;
    try{
      const format=await dialog.showMessageBox(window,{type:'question',message:'导入题库',detail:'选择完整题库文件夹或 ZIP 文件。导入成功后切换题库，旧题库会自动备份。',buttons:['题库文件夹','ZIP 文件','取消'],cancelId:2});
      if(format.response===2)return null;
      const choice=await dialog.showOpenDialog(window,{title:format.response===1?'选择完整题库 ZIP 文件':'选择包含 catalog.md 的完整题库文件夹',defaultPath:path.join(root,'datasets'),properties:[format.response===1?'openFile':'openDirectory'],...format.response===1?{filters:[{name:'题库 ZIP',extensions:['zip']}]}:{}});
      if(choice.canceled)return null;
      const status=await fetch(origin+'/api/control/app').then(r=>r.json());
      if(status.busy||status.errors?.length||status.jobs.some(j=>['STARTING','RUNNING','CANCELLING'].includes(j.state)))throw Error('请等待评测和题库准备结束，并确认运行记录可读取后再导入');
      const library=await fetch(origin+'/api/control/library').then(r=>r.json());
      if(library.selection?.state==='PREPARING'||['DOWNLOADING','INSTALLING'].includes(library.state)||['DOWNLOADING','INSTALLING'].includes(library.download?.state))throw Error('请等待题库准备完成或取消后再导入');
      await stopBackend();automaticLibrary=false;
      let message;
      try{const result=await (format.response===1?importLibraryArchive:importLibrary)(choice.filePaths[0],root);message=`已导入 ${result.datasets} 个测试集，共 ${result.cases} 题。旧题库已备份。`;}
      catch(error){message='导入失败：'+error.message;}
      await startBackend();await window.loadURL(origin+'/app.html?notice='+encodeURIComponent(message)+'#datasets');
      return null;
    }finally{importing=false;}
  });
  await window.loadURL(origin+'/app.html');
  if(updates.status().state!=='DISABLED')void updates.check();
  window.on('close',event=>{if(!quitting){event.preventDefault();app.quit();}});
}
app.on('before-quit',event=>{if(backend&&!quitting){event.preventDefault();quitting=true;stopBackend().finally(()=>app.quit());}});
