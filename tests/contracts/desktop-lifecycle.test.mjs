import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {EventEmitter} from 'node:events';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

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
  constructor(options){super();this.options=options;windows.push(this);const contents=new EventEmitter();
   contents.setWindowOpenHandler=handler=>{contents.openWindow=handler;};
   contents.session={setPermissionRequestHandler:handler=>{contents.permission=handler;},webRequest:{onBeforeRequest:handler=>{contents.beforeRequest=handler;},onHeadersReceived:handler=>{contents.headersReceived=handler;}}};this.webContents=contents;}
  loadURL(url){this.url=url;return new Promise((resolve,reject)=>{this.resolveLoad=resolve;this.rejectLoad=reject;});}
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
  DesktopUpdates,updateEligible:()=>false,updaterPackage:{autoUpdater:{}},process:{env:{},execPath:'synthetic-electron'},setTimeout,clearTimeout,URL,
 },{filename:entry});
 const settle=async()=>{for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));};
 await settle();assert.equal(windows.length,1);assert.ok(windows[0].rejectLoad,'renderer load is pending');
 return {app,window:windows[0],windows,errors,stops,settle};
}
test('desktop reports load Trace scripts in an isolated read-only session',async()=>{
 const state=await desktop(),url='http://127.0.0.1:12345/reports/pi/run/cases/case/report.html';
 assert.equal(state.window.webContents.openWindow({url}).action,'deny');
 const report=state.windows[1],preferences=report.options.webPreferences;
 assert.equal(preferences.javascript,true,'report-data.js must run to render Trace evidence');
 assert.equal(preferences.sandbox,true);assert.equal(preferences.nodeIntegration,false);assert.equal(preferences.contextIsolation,true);
 assert.ok(preferences.partition&&!preferences.partition.startsWith('persist:'));
 assert.equal(report.url,url);
 const allowed=(relative,method='GET',resourceType='xhr')=>{let result;report.webContents.beforeRequest({url:new URL(relative,url).href,method,resourceType},value=>{result=value;});return !result.cancel;};
 assert.equal(allowed('report.html','GET','mainFrame'),true);
 assert.equal(allowed('report-data.js','GET','script'),true);
 assert.equal(allowed('all-trace/manifest.json'),true);
 assert.equal(allowed('all-trace/blobs/'+'a'.repeat(64)),true);
 assert.equal(allowed('output/answer.json'),true);
 assert.equal(allowed('/api/control/pi/run','POST'),false);
 assert.equal(allowed('/api/control/app'),false);
 assert.equal(allowed('https://example.com/collect'),false);
 assert.equal(allowed('file:///tmp/private'),false);
 assert.equal(allowed('output/injected.js','GET','script'),false);
 assert.equal(allowed('report-data.js','POST','script'),false);
 let headers;report.webContents.headersReceived({responseHeaders:{'content-security-policy':['sandbox']}},value=>{headers=value.responseHeaders;});
 assert.equal(headers['content-security-policy'][0],'sandbox');
 assert.ok(headers['content-security-policy'][1].includes("default-src 'none'"));
 assert.ok(headers['content-security-policy'][1].includes("form-action 'none'"));
 assert.ok(!headers['content-security-policy'][1].includes("script-src 'unsafe-inline'"));
 let permitted;report.webContents.permission(null,'camera',value=>{permitted=value;});assert.equal(permitted,false);
 assert.equal(report.webContents.openWindow({url}).action,'deny');
 let prevented=false;report.webContents.emit('will-navigate',{preventDefault(){prevented=true;}});assert.equal(prevented,true);
});
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
