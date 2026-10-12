import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,cp,mkdir,writeFile,readFile,rm,readdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {BenchDockLibrary} from '../../workbench/lib/benchdock-library.mjs';
import {isBundledLibrary} from '../../desktop/workspace.mjs';
import {renderLibrary} from '../../workbench/design-prototypes/product-pages.js';
import {startControlServer} from '../../workbench/control-server.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
async function fixture(t){
 const root=await mkdtemp(path.join(os.tmpdir(),'evaldock-auto-library-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await cp('dist',path.join(root,'dist'),{recursive:true});await cp('datasets',path.join(root,'datasets'),{recursive:true});
 await mkdir(path.join(root,'config'));await writeFile(path.join(root,'package.json'),'{"type":"module"}');
 const input=Buffer.from('public input'),row={schema:'benchdock.catalog/v1',task_id:'fixture-1',title:'Synthetic public task',prompt:'Read input/data.txt and write output/answer.txt.',distribution:'bundled',inputs:[{path:'datasets/sample/input/data.txt',destination:'input/data.txt',bytes:input.length,sha256:sha(input)}],license_files:['licenses/demo.txt']};
 const files=new Map([['datasets/sample/input/data.txt',input],['datasets/sample/task.json',Buffer.from(JSON.stringify(row))],['catalog.jsonl',Buffer.from(JSON.stringify(row)+'\n')],['LICENSE',Buffer.from('Synthetic license')],['NOTICE.md',Buffer.from('Synthetic notice')],['licenses/demo.txt',Buffer.from('Synthetic attribution')],['private/reference.json',Buffer.from('not downloadable')]]);
 const profile={schema:'evaldock.benchdock-profile/v1',repo_id:'EvalDock/BenchDock',revision:'a'.repeat(40),tasks:[{task_id:row.task_id,task_path:'datasets/sample/task.json',capabilityLabels:['artifact-delivery','efficiency-cost'],environment:{platform:'portable',timeoutSeconds:30,allowedEdits:['work/**','output/**'],dependencies:[]}}]};
 async function refresh(){files.set('catalog.jsonl',Buffer.from(JSON.stringify(row)+'\n'));files.set('datasets/sample/task.json',Buffer.from(JSON.stringify(row)));const bytes=Buffer.from([...files].filter(([name])=>name!=='FILES.jsonl').map(([name,data])=>JSON.stringify({path:name,bytes:data.length,sha256:sha(data)})).join('\n')+'\n');files.set('FILES.jsonl',bytes);profile.manifest_sha256=sha(bytes);await writeFile(path.join(root,'config/benchdock-pilot.json'),JSON.stringify(profile));}
 await refresh();const requests=[];
 const fetchImpl=async(url,options)=>{
  assert.equal(options?.headers?.authorization,undefined);assert.equal(options?.headers?.cookie,undefined);
  assert.match(url,new RegExp('https://huggingface.co/datasets/EvalDock/BenchDock/(raw|resolve)/'+profile.revision+'/'));
  const name=decodeURIComponent(url.split('/'+profile.revision+'/')[1]);requests.push(name);return new Response(files.get(name),{status:files.has(name)?200:404});
 };
 const service=async(options={})=>{const s=new BenchDockLibrary({root,automatic:true,fetchImpl,...options});await s.init();return s;};
 return {root,row,files,profile,requests,refresh,fetchImpl,service};
}
test('automatic preparation downloads only selected public files, validates and backs up before switching',async t=>{
 const f=await fixture(t),library=await f.service();
 const first=library.start();assert.equal(first.state,'DOWNLOADING');library.start();await library.pending;
 assert.equal(library.status().state,'READY');assert.equal(library.status().cases,1);
 assert.equal(library.status().completedFiles,library.status().totalFiles);
 assert.equal(f.requests.filter(n=>n==='FILES.jsonl').length,1);assert.ok(!f.requests.some(n=>n.startsWith('private/')));
 const directory=(await readdir(path.join(f.root,'datasets/benchdock-public')))[0];
 const question=JSON.parse(await readFile(path.join(f.root,'datasets/benchdock-public',directory,'question.json')));
 assert.equal(question.grading.mode,'unavailable');assert.equal(question.benchdock.revision,f.profile.revision);
 assert.equal((await readdir(path.join(f.root,'dataset-history'))).length,1);
 const reopened=await f.service({automatic:false,fetchImpl:()=>{throw Error('Network must not be needed');}});
 assert.equal(reopened.status().state,'READY');assert.equal(reopened.status().cases,1);
});
test('manifest mismatch and source-only tasks preserve the installed library',async t=>{
 for(const mode of ['manifest','source-only']){
  const f=await fixture(t),before=await readFile(path.join(f.root,'datasets/catalog.md'));
  if(mode==='manifest')f.files.set('FILES.jsonl',Buffer.from('{}'));
  else{f.row.distribution='source_reference';await f.refresh();}
  const library=await f.service();library.start();await library.pending;
  assert.equal(library.status().state,'FAILED');assert.deepEqual(await readFile(path.join(f.root,'datasets/catalog.md')),before);
  assert.ok(!f.requests.includes('datasets/sample/input/data.txt'));
 }
});
test('cancellation stops network preparation and retains the previous library',async t=>{
 const f=await fixture(t),before=await readFile(path.join(f.root,'datasets/catalog.md'));
 let requested;const seen=new Promise(resolve=>{requested=resolve;});
 const library=await f.service({fetchImpl:async(url,options)=>{
  if(url.endsWith('catalog.jsonl')){requested();return new Promise((resolve,reject)=>{options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true});});}
  return f.fetchImpl(url,options);
 }});
 library.start();await seen;await library.cancel();assert.equal(library.status().state,'CANCELLED');
 assert.deepEqual(await readFile(path.join(f.root,'datasets/catalog.md')),before);
 assert.equal((await readdir(path.join(f.root,'var/benchdock-cache'))).some(n=>n.startsWith('.import-')),false);
});
test('changed local data or active evaluation prevents automatic installation',async t=>{
 for(const mode of ['local-change','active']){
  const f=await fixture(t),library=await f.service({canInstall:async()=>mode!=='active'});
  if(mode==='local-change')await writeFile(path.join(f.root,'datasets/keep-local.txt'),'user-owned');
  const before=await readFile(path.join(f.root,'datasets/catalog.md'));library.start();await library.pending;
  assert.equal(library.status().state,'FAILED');assert.deepEqual(await readFile(path.join(f.root,'datasets/catalog.md')),before);
  if(mode==='local-change')assert.equal(await readFile(path.join(f.root,'datasets/keep-local.txt'),'utf8'),'user-owned');
 }
});
test('retries reuse verified bytes but reject and refetch damaged cache entries',async t=>{
 const f=await fixture(t),first=await f.service({canInstall:async()=>false});first.start();await first.pending;
 const cache=path.join(f.root,'var/benchdock-cache',f.profile.revision,sha(Buffer.from('datasets/sample/input/data.txt')));
 await writeFile(cache,'corrupt');f.requests.length=0;
 const second=await f.service();second.start();await second.pending;assert.equal(second.status().state,'READY');
 assert.deepEqual(f.requests.sort(),['FILES.jsonl','datasets/sample/input/data.txt'].sort());
});
test('default detection preserves custom imports and local changes',async t=>{
 const f=await fixture(t);assert.equal(await isBundledLibrary(process.cwd(),f.root),true);
 await writeFile(path.join(f.root,'datasets/evaldock-import.json'),JSON.stringify({datasets:1,cases:1,sha256:'a'.repeat(64)}));assert.equal(await isBundledLibrary(process.cwd(),f.root),true);
 await writeFile(path.join(f.root,'datasets/evaldock-import.json'),'{}');assert.equal(await isBundledLibrary(process.cwd(),f.root),false);
 await rm(path.join(f.root,'datasets/evaldock-import.json'));await writeFile(path.join(f.root,'datasets/basic-file-delivery/case-001/input/numbers.json'),'{}');
 assert.equal(await isBundledLibrary(process.cwd(),f.root),false);
 const custom=await f.service({automatic:false});custom.start();assert.equal(custom.status().state,'LOCAL');assert.equal(f.requests.length,0);
});
test('download UI escapes errors, distinguishes preparation from readiness and states scoring limits',()=>{
 const failed=renderLibrary({automatic:true,state:'FAILED',error:'<script>bad</script>'});assert.ok(!failed.includes('<script>'));assert.match(failed,/重试准备题库/);
 const preparing=renderLibrary({automatic:true,state:'DOWNLOADING',completedFiles:2,totalFiles:8});assert.match(preparing,/2 \/ 8/);assert.match(preparing,/取消下载/);assert.ok(!preparing.includes('已就绪'));
 const ready=renderLibrary({automatic:true,state:'READY',cases:3});assert.match(ready,/3 道/);assert.match(ready,/无法评分/);
});
test('library routes enforce CSRF and automatic runs wait for verified installation',async t=>{
 const f=await fixture(t);let calls=0,state='DOWNLOADING';
 const controller={env:{},jobs:{jobs:new Map()},status:async()=>({targets:[]}),run:async()=>{calls++;return {id:'actual-run'};}};
 const libraryService={status:()=>({automatic:true,state}),start:()=>({state}),cancel:async()=>({state:'CANCELLED'}),get ready(){return state==='READY';},get installing(){return state==='INSTALLING';}};
 const {server}=await startControlServer({root:f.root,port:0,controller,workbuddyController:controller,agentControllers:{},libraryService});
 t.after(()=>new Promise(resolve=>server.close(resolve)));const base='http://127.0.0.1:'+server.address().port;
 const {csrf}=await(await fetch(base+'/api/control/model-settings')).json();
 const post=(route,body,token=csrf)=>fetch(base+'/api/control/'+route,{method:'POST',headers:{'content-type':'application/json','x-workbench-token':token},body:JSON.stringify(body)});
 assert.equal((await post('library/prepare',{},'wrong')).status,403);assert.equal((await post('library/prepare',{url:'https://outside.invalid'})).status,409);
 const input={evaluationConfig:{mode:'FULL',selection:{kind:'STANDARD'}}};
 assert.equal((await post('run',input)).status,409);assert.equal(calls,0);
 state='INSTALLING';assert.equal((await post('run',input)).status,409);assert.equal(calls,0);
 state='READY';assert.equal((await post('run',input)).status,200);assert.equal(calls,1);
 assert.equal((await(await post('library/cancel',{})).json()).state,'CANCELLED');
});
