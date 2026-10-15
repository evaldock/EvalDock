import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {EventEmitter} from 'node:events';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import {backendEnvironment,windowPlatformOptions,applicationMenu} from '../../desktop/platform.mjs';

// Exercise the actual entry point with a deferred renderer load and owned backend.
// Closing a loading window rejects loadURL, as Electron does during an early quit.
async function desktop(){
 const entry=path.resolve('desktop/main.mjs');
 const source=(await readFile(entry,'utf8')).replace(/^import .*;\r?\n/gm,'').replaceAll('import.meta.url',JSON.stringify(pathToFileURL(entry).href));
 const errors=[],windows=[],stops=[];
 const app=new EventEmitter();
 Object.assign(app,{setName(){},requestSingleInstanceLock:()=>true,whenReady:()=>Promise.resolve(),getPath:()=>'/synthetic/workspace',getVersion:()=>'0.1.0',isPackaged:false,dock:{setIcon(){}}});
 app.quit=()=>{
  const event={prevented:false,preventDefault(){this.prevented=true;}};
  app.emit('before-quit',event);if(event.prevented)return;
  for(const window of windows)if(!window.closed){window.closed=true;window.rejectLoad?.(Error('ERR_FAILED (-2) loading synthetic app.html'));window.emit('closed');}
  app.emit('quit');
 };
 class BrowserWindow extends EventEmitter{
  constructor(){super();windows.push(this);this.webContents={setWindowOpenHandler(){},on(){},session:{setPermissionRequestHandler(){}}};}
  loadURL(){return new Promise((resolve,reject)=>{this.resolveLoad=resolve;this.rejectLoad=reject;});}
 }
 function fork(){
  const child=new EventEmitter();child.exitCode=null;
  child.send=message=>{assert.equal(message,'stop');stops.push(message);setImmediate(()=>{child.exitCode=0;child.emit('exit',0);});};
  child.kill=()=>{throw Error('A normal quit must not kill the backend');};
  setImmediate(()=>child.emit('message',{type:'ready',port:12345}));return child;
 }
 class DesktopUpdates{status(){return {state:'DISABLED'};}}
 vm.runInNewContext(source,{
  app,BrowserWindow,Menu:{setApplicationMenu(){},buildFromTemplate:x=>x},dialog:{showErrorBox:(title,message)=>errors.push({title,message})},ipcMain:{handle(){}},shell:{},fork,
  mkdir:async()=>{},open:async()=>({fd:1,close:async()=>{}}),path,fileURLToPath,prepareWorkspace:async()=>{},isBundledLibrary:async()=>false,
  backendEnvironment:options=>backendEnvironment({...options,environment:{},platform:process.platform}),windowPlatformOptions,applicationMenu,
  DesktopUpdates,updateEligible:()=>false,updaterPackage:{autoUpdater:{}},process:{env:{},platform:process.platform,execPath:'synthetic-electron'},setTimeout,clearTimeout,URL,
 },{filename:entry});
 const settle=async()=>{for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));};
 await settle();assert.equal(windows.length,1);assert.ok(windows[0].rejectLoad,'renderer load is pending');
 return {app,window:windows[0],errors,stops,settle};
}
test('quitting during the initial renderer load closes without a startup error dialog',async()=>{
 const state=await desktop();state.app.quit();await state.settle();
 assert.deepEqual(state.stops,['stop']);assert.equal(state.window.closed,true);
 assert.deepEqual(state.errors,[],'intentional window closure must not open a blocking startup dialog');
});
test('an actual renderer startup failure still reports the error and stops its backend',async()=>{
 const state=await desktop();state.window.rejectLoad(Error('synthetic renderer startup failure'));await state.settle();
 assert.deepEqual(state.errors,[{title:'EvalDock 启动失败',message:'synthetic renderer startup failure'}]);
 assert.deepEqual(state.stops,['stop']);assert.equal(state.window.closed,true);
});
