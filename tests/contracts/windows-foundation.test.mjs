import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,writeFile,readFile,cp,readdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {temporary,json} from './support.mjs';
import {backendEnvironment,windowPlatformOptions,applicationMenu} from '../../desktop/platform.mjs';
import {platformEnvironment} from '../../adapters/shared/platform-environment.mjs';
import {selectPython} from '../../scripts/run-python-tests.mjs';
import {initializeDshController} from '../../workbench/lib/initialize-dsh.mjs';
import {startControlServer} from '../../workbench/control-server.mjs';
import {AgentModelSettings} from '../../workbench/lib/agent-model-settings.mjs';
import {projectPaths} from '../../workbench/lib/paths.mjs';
import {LibraryPaths} from '../../desktop/library-paths.mjs';
import {prepareWorkspace,importLibrary,libraryFingerprint} from '../../desktop/workspace.mjs';
import audit from '../../scripts/audit-desktop-runtime.cjs';
import signatureHook from '../../scripts/verify-desktop-signature.cjs';

test('Windows background inherits one PATH and retains the Electron Node runtime',()=>{
  const root='C:\\Eval Dock\\数据';
  const env=backendEnvironment({platform:'win32',root,environment:{Path:'C:\\Tools;D:\\Agent Tools',SystemRoot:'C:\\Windows'},automaticLibrary:true});
  assert.equal(env.PATH,'C:\\Tools;D:\\Agent Tools');assert.equal(env.Path,undefined);
  assert.equal(env.ELECTRON_RUN_AS_NODE,'1');assert.equal(env.EVALDOCK_DATASETS_ROOT,root);assert.equal(env.EVALDOCK_AUTO_DATASETS,'1');
  const duplicate=backendEnvironment({platform:'win32',root,environment:{PATH:'one',Path:'two'}});
  assert.deepEqual(Object.keys(duplicate).filter(k=>k.toLowerCase()==='path'),['PATH']);assert.equal(duplicate.PATH,'one');
  assert.match(backendEnvironment({platform:'darwin',root,environment:{PATH:'/custom'}}).PATH,/^\/custom:.*\/usr\/bin/);
  assert.equal(windowPlatformOptions('win32','icon.ico').titleBarStyle,'default');assert.equal(windowPlatformOptions('darwin').titleBarStyle,'hiddenInset');
  assert.equal(applicationMenu('win32',[]).submenu.some(item=>item.role==='hide'),false);
  assert.equal(applicationMenu('darwin',[]).submenu.some(item=>item.role==='hide'),true);
});
test('Windows target environment retains required OS variables without evaluator secrets',()=>{
  const source={Path:'C:\\Tools',systemroot:'C:\\Windows',COMSPEC:'C:\\Windows\\System32\\cmd.exe',TEMP:'C:\\Temp',TMP:'C:\\Temp',USERPROFILE:'C:\\Profile',APPDATA:'C:\\Profile\\Roaming',LOCALAPPDATA:'C:\\Profile\\Local',PATHEXT:'.EXE;.CMD',HOME:'isolated',EVALDOCK_PLANNER_API_KEY:'planner',EVALDOCK_JUDGE_API_KEY:'judge',DEEPSEEK_API_KEY:'target',NODE_OPTIONS:'--require unwanted'};
  const env=platformEnvironment(source,{platform:'win32'});
  for(const key of ['PATH','SystemRoot','ComSpec','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA','PATHEXT'])assert.ok(env[key],key);
  for(const key of ['Path','HOME','EVALDOCK_PLANNER_API_KEY','EVALDOCK_JUDGE_API_KEY','DEEPSEEK_API_KEY','NODE_OPTIONS'])assert.equal(env[key],undefined,key);
  assert.equal(platformEnvironment(source,{platform:'win32',includeHome:true}).HOME,'isolated');
});
test('Python probe selects py -3 on Windows and respects a failing explicit interpreter',()=>{
  const calls=[];
  const choice=selectPython({platform:'win32',environment:{},run:(command,args)=>{calls.push([command,args]);return {status:command==='py'?0:1,stdout:command==='py'?'3\r\n':''};}});
  assert.deepEqual(choice,{command:'py',prefix:['-3']});assert.equal(calls.length,2);assert.equal(calls[1][1][0],'-3');
  let attempted=0;assert.throws(()=>selectPython({platform:'win32',environment:{EVALDOCK_PYTHON:'custom python'},run:()=>{attempted++;return {status:0,stdout:'2'};}}),/Python 3/);assert.equal(attempted,1);
});
test('missing or malformed DSH config preserves live HTTP settings, sibling and DSH history',async t=>{
  for(const descriptor of [undefined,'{broken']){
    const root=await temporary(t);
    if(descriptor!==undefined){await mkdir(path.join(root,'config/targets'),{recursive:true});await writeFile(path.join(root,'config/targets/real-dsh.json'),descriptor);}
    const job={id:'prior',targetId:'dsh',runId:'prior-run',state:'SUCCEEDED',createdAt:'2026-01-01',sequence:0,events:[]};
    await json(path.join(projectPaths(root).workbench,'control/jobs/prior.json'),job);
    await mkdir(path.join(root,'workbench/design-prototypes'),{recursive:true});await cp('workbench/design-prototypes/app.html',path.join(root,'workbench/design-prototypes/app.html'));
    const quiet={active:false,status:async()=>({targets:[]}),records:async()=>({jobs:[{id:'sibling',createdAt:'2026-01-02',agentKind:'pi'}],runs:[]}),jobs:{jobs:new Map()}};
    const agentModelSettings=new AgentModelSettings({file:path.join(root,'target.env'),legacyFile:path.join(root,'legacy.env'),environment:{}});
    const runtime=await startControlServer({root,port:0,workbuddyController:quiet,agentControllers:{},modelSettingsFile:path.join(root,'models.env'),agentModelSettings});
    t.after(async()=>{await runtime.control.jobs.shutdown();await new Promise(resolve=>runtime.server.close(resolve));});
    const origin='http://127.0.0.1:'+runtime.server.address().port;
    assert.equal((await fetch(origin+'/app.html')).status,200);
    const summary=await fetch(origin+'/api/control/app').then(r=>r.json());
    assert.ok(summary.jobs.some(j=>j.id==='prior'));assert.ok(summary.jobs.some(j=>j.id==='sibling'));
    assert.equal(summary.errors.length,0);assert.equal(summary.agents[0].targets[0].evaluationReady,false);
    const settings=await fetch(origin+'/api/control/model-settings').then(r=>r.json());
    const post=(route,input,token=settings.csrf)=>fetch(origin+'/api/control/'+route,{method:'POST',headers:{'content-type':'application/json','x-workbench-token':token},body:JSON.stringify(input)});
    assert.equal((await post('model-settings',{planner:{apiKey:'synthetic-planner'},reusePlannerForJudge:true})).status,200);
    const publicSettings=await fetch(origin+'/api/control/model-settings').then(r=>r.text());assert.ok(!publicSettings.includes('synthetic-planner'));
    assert.equal((await post('service',{action:'start'})).status,409);assert.equal((await post('service',{action:'start'},'wrong')).status,403);
    assert.equal((await fetch(origin+'/api/control/activity')).status,200);
    if(descriptor!==undefined)assert.equal(await readFile(path.join(root,'config/targets/real-dsh.json'),'utf8'),descriptor);
  }
});
test('Windows DSH is explicitly unavailable and unreadable history stays fail-closed',async t=>{
  const root=await temporary(t),control=await initializeDshController(root,{platform:'win32'});
  assert.equal((await control.status()).reasonCode,'DSH_PLATFORM_UNSUPPORTED');await assert.rejects(control.run({}),/Windows/);
  await mkdir(path.join(projectPaths(root).workbench,'control/jobs'),{recursive:true});await writeFile(path.join(projectPaths(root).workbench,'control/jobs/broken.json'),'{broken');
  const broken=await initializeDshController(root,{platform:'win32'});await assert.rejects(broken.records(),/历史记录/);
});
test('workspace refresh preserves malformed optional DSH config and tolerates its absence',async t=>{
  const parent=await temporary(t),source=path.join(parent,'source');
  for(const name of ['dist','adapters','workbench','labels','planning','trace','observer-lab','src','desktop','node_modules','config','datasets','environments'])await mkdir(path.join(source,name),{recursive:true});
  await writeFile(path.join(source,'package.json'),'{"type":"module"}');
  const root=path.join(parent,'workspace');await prepareWorkspace(source,root);
  await mkdir(path.join(root,'config/targets'));await writeFile(path.join(root,'config/targets/real-dsh.json'),'{broken');
  await prepareWorkspace(source,root);assert.equal(await readFile(path.join(root,'config/targets/real-dsh.json'),'utf8'),'{broken');
});
test('portable library names reject Windows aliases and implicit parent collisions',()=>{
  for(const name of ['CON','CONIN$','nul.txt','COM1.json','LPT².log','dir/aux.data','dir/name.','dir/name ','file:stream','C:/file','//server/share','dir/a?b','dir/a*b','a\\b'])assert.throws(()=>new LibraryPaths({platform:'win32'}).add(name),/路径/,name);
  assert.doesNotThrow(()=>new LibraryPaths({platform:'darwin'}).add('aux.txt'));
  const names=new LibraryPaths();names.add('中文 目录/data.txt');names.add('中文 目录',{directory:true});
  assert.throws(()=>names.add('中文 目录/DATA.TXT'),/冲突/);
  const parents=new LibraryPaths();parents.add('folder/a.txt');assert.throws(()=>parents.add('Folder/b.txt'),/冲突/);
  const unicode=new LibraryPaths();unicode.add('café/a');assert.throws(()=>unicode.add('cafe\u0301/b'),/冲突/);
});
test('cancelling validated folder import preserves the installed library and removes staging',async t=>{
  const root=await temporary(t);await cp('dist',path.join(root,'dist'),{recursive:true});await writeFile(path.join(root,'package.json'),'{"type":"module"}');await cp('datasets',path.join(root,'datasets'),{recursive:true});
  const before=await libraryFingerprint(path.join(root,'datasets')),controller=new AbortController();
  await assert.rejects(importLibrary(path.resolve('datasets'),root,{signal:controller.signal,onProgress:progress=>{if(progress.phase==='COMMITTING')controller.abort();}}),{name:'AbortError'});
  assert.equal(await libraryFingerprint(path.join(root,'datasets')),before);assert.equal((await readdir(root)).some(name=>name.startsWith('.dataset-import-')),false);
});
test('Windows bundle audit reads actual resources and rejects private paths and undeclared bytes',async t=>{
  const root=await temporary(t),resources=path.join(root,'resources'),runtime=path.join(resources,'runtime');
  await cp('desktop/empty-library',path.join(runtime,'datasets'),{recursive:true});
  const source=path.join(root,'source');await mkdir(path.join(source,'desktop'),{recursive:true});await writeFile(path.join(source,'desktop/main.mjs'),'export const ready=true;');
  const asar=createRequire(createRequire(import.meta.url).resolve('electron-builder'))('@electron/asar');await asar.createPackage(source,path.join(resources,'app.asar'));
  assert.ok(audit.auditDesktopBundle(root,{platform:'win32'}).every(file=>file.path.startsWith('resources/')));
  await mkdir(path.join(runtime,'dist'));await writeFile(path.join(runtime,'dist/private.js'),JSON.stringify({home:'C:'+String.fromCharCode(92)+'Users'+String.fromCharCode(92)+'synthetic-person'}));
  assert.throws(()=>audit.auditDesktopBundle(root,{platform:'win32'}),/personal home path/);
  await signatureHook({electronPlatformName:'win32',appOutDir:root});
});
