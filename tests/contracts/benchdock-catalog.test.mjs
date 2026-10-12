import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,cp,mkdir,writeFile,readFile,rm,readdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {BenchDockLibrary} from '../../workbench/lib/benchdock-library.mjs';
import {libraryFingerprint} from '../../desktop/workspace.mjs';
import {evaluationCatalog} from '../../workbench/lib/evaluation-config.mjs';
import {datasetDirectory,renderDatasets,selectedItems} from '../../workbench/design-prototypes/product-pages.js';
import {startControlServer} from '../../workbench/control-server.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fixture(t){
 const root=await mkdtemp(path.join(os.tmpdir(),'evaldock-directory-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await cp('dist',path.join(root,'dist'),{recursive:true});await cp('datasets',path.join(root,'datasets'),{recursive:true});
 await mkdir(path.join(root,'config'));await writeFile(path.join(root,'package.json'),'{"type":"module"}');
 const input=Buffer.from('synthetic public input');
 const rows=[
  {schema:'benchdock.catalog/v1',task_id:'fixture-public-1',subset:'Synthetic mixed set',title:'Synthetic input task',prompt:'Read input/data.txt and write output/answer.txt.',distribution:'bundled',environment_status:'inputs_bundled_python_required',inputs:[{path:'datasets/sample/input/data.txt',destination:'input/data.txt',bytes:input.length,sha256:sha(input)}],license_files:['licenses/demo.txt']},
  {schema:'benchdock.catalog/v1',task_id:'fixture-source-1',subset:'Synthetic mixed set',title:null,prompt:null,distribution:'source_reference',inputs:[],license_files:[]},
  {schema:'benchdock.catalog/v1',task_id:'fixture-public-2',subset:'Synthetic second set',title:'Synthetic text task',prompt:'Write output/answer.txt.',distribution:'bundled',environment_status:'external_setup_required',inputs:[],license_files:['licenses/demo.txt']},
  {schema:'benchdock.catalog/v1',task_id:'fixture-source-2',subset:'Synthetic source set',title:null,prompt:null,distribution:'source_reference',inputs:[],license_files:[]},
 ];
 const files=new Map([['datasets/sample/input/data.txt',input],['LICENSE',Buffer.from('Synthetic license')],['NOTICE.md',Buffer.from('Synthetic notice')],['licenses/demo.txt',Buffer.from('Synthetic attribution')],['private/reference.json',Buffer.from('must stay private')]]);
 const profile={schema:'evaldock.benchdock-profile/v1',repo_id:'EvalDock/BenchDock',revision:'b'.repeat(40),tasks:[{task_id:rows[0].task_id,task_path:'datasets/sample/task.json',capabilityLabels:['artifact-delivery'],environment:{platform:'portable',timeoutSeconds:30,allowedEdits:['work/**','output/**'],dependencies:[]}}]};
 async function refresh(){
  files.set('catalog.jsonl',Buffer.from(rows.map(row=>JSON.stringify(row)).join('\n')+'\n'));
  const manifest=Buffer.from([...files].filter(([name])=>name!=='FILES.jsonl').map(([name,bytes])=>JSON.stringify({path:name,bytes:bytes.length,sha256:sha(bytes)})).join('\n')+'\n');
  files.set('FILES.jsonl',manifest);profile.manifest_sha256=sha(manifest);await writeFile(path.join(root,'config/benchdock-pilot.json'),JSON.stringify(profile));
 }
 await refresh();const requests=[];
 const fetchImpl=async(url,options)=>{
  assert.equal(options?.headers?.authorization,undefined);assert.equal(options?.headers?.cookie,undefined);
  assert.match(url,new RegExp('^https://huggingface.co/datasets/EvalDock/BenchDock/(raw|resolve)/'+profile.revision+'/'));
  const name=decodeURIComponent(url.split('/'+profile.revision+'/')[1]);requests.push(name);
  return new Response(files.get(name),{status:files.has(name)?200:404});
 };
 const service=async(options={})=>{const library=new BenchDockLibrary({root,automatic:false,fetchImpl,...options});await library.init();t.after(()=>library.close());return library;};
 const load=async library=>{library.loadCatalog();await library.catalog.indexPending;return library.status().catalog;};
 return {root,rows,files,profile,requests,fetchImpl,refresh,service,load};
}

test('directory loads without installing tasks and exposes metadata only; a pinned cache works offline',async t=>{
 const f=await fixture(t),library=await f.service(),before=await libraryFingerprint(path.join(f.root,'datasets'));
 const directory=await f.load(library);
 assert.equal(directory.state,'READY');assert.equal(directory.datasets.length,3);
 assert.equal(directory.datasets.reduce((sum,dataset)=>sum+dataset.caseCount,0),4);
 const mixed=directory.datasets.find(dataset=>dataset.name==='Synthetic mixed set');
 assert.equal(mixed.downloadableCases,1);assert.equal(mixed.sourceOnlyCases,1);
 assert.doesNotMatch(JSON.stringify(directory),/Read input|must stay private|reference\.json/);
 assert.equal(await libraryFingerprint(path.join(f.root,'datasets')),before);
 assert.deepEqual(f.requests,['FILES.jsonl','catalog.jsonl']);
 const offline=await f.service({fetchImpl:()=>{throw Error('Offline cache must not access the network');}});
 assert.deepEqual(offline.status().catalog,directory);assert.equal((await evaluationCatalog(f.root)).datasets.length,1);
});

test('explicit subset download adds selectable public cases and retains existing private references and datasets',async t=>{
 const f=await fixture(t),library=await f.service();await f.load(library);
 const existing=await evaluationCatalog(f.root),privateFile='datasets/basic-file-delivery/case-001/private/final.json';
 const reference=await readFile(path.join(f.root,privateFile)),mixed=library.status().catalog.datasets.find(dataset=>dataset.downloadableCases===1&&dataset.sourceOnlyCases===1);
 assert.equal(library.downloadDataset(mixed.id).download.state,'DOWNLOADING');await library.catalog.pending;
 assert.equal(library.status().download.state,'READY');assert.equal(library.status().download.completedFiles,library.status().download.totalFiles);
 const local=await evaluationCatalog(f.root),installed=local.datasets.find(dataset=>dataset.id===mixed.id);
 assert.equal(local.datasets.length,2);assert.equal(installed.cases.length,1);assert.equal(installed.cases[0].scoringState,'UNAVAILABLE');
 assert.equal(local.scoring.readyCases,existing.scoring.readyCases);assert.deepEqual(await readFile(path.join(f.root,privateFile)),reference);
 assert.deepEqual(local.datasets.find(dataset=>dataset.id===existing.datasets[0].id),existing.datasets[0]);
 assert.equal((await readdir(path.join(f.root,'dataset-history'))).length,1);assert.ok(!f.requests.some(name=>name.includes('private/')));
 const directory=datasetDirectory(local,library.status());assert.equal(directory.filter(dataset=>dataset.id===mixed.id).length,1);assert.equal(directory.find(dataset=>dataset.id===mixed.id).local,true);
 const source=directory.find(dataset=>dataset.downloadableCases===0);
 assert.deepEqual(selectedItems(local,new Map([[mixed.id,new Set([0,1])],[source.id,new Set([0])]])),[{datasetId:mixed.id,caseIndices:[0]}]);
 const other=library.status().catalog.datasets.find(dataset=>dataset.name==='Synthetic second set');
 library.downloadDataset(other.id);await library.catalog.pending;
 assert.equal(library.status().download.state,'READY');assert.equal((await evaluationCatalog(f.root)).datasets.length,3);
 const offline=await f.service({fetchImpl:()=>{throw Error('No network expected');}});assert.equal(offline.ready,true);assert.equal(offline.status().catalog.state,'READY');
 offline.downloadDataset(mixed.id);await offline.catalog.pending;assert.equal(offline.status().download.state,'FAILED');
 assert.equal((await readdir(path.join(f.root,'dataset-history'))).length,2);
});

test('invalid manifests, unsafe public paths and source-only downloads never change the local library',async t=>{
 for(const mode of ['manifest','private-input','source-only']){
  const f=await fixture(t),before=await libraryFingerprint(path.join(f.root,'datasets'));
  if(mode==='manifest')f.files.set('FILES.jsonl',Buffer.from('{}'));
  if(mode==='private-input'){f.rows[0].inputs[0].path='private/reference.json';await f.refresh();}
  const library=await f.service();await f.load(library);
  if(mode==='source-only'){
   const source=library.status().catalog.datasets.find(dataset=>!dataset.downloadableCases);
   assert.throws(()=>library.downloadDataset(source.id),/仅提供来源信息/);
  }else assert.equal(library.status().catalog.state,'FAILED');
  assert.equal(await libraryFingerprint(path.join(f.root,'datasets')),before);
  assert.ok(!f.requests.some(name=>name.startsWith('private/')));
 }
});

test('a legacy installed subset cannot be replaced or duplicated by its online download',async t=>{
 const f=await fixture(t);f.rows[0].subset='basic-file-delivery';f.rows[1].subset='basic-file-delivery';await f.refresh();
 const library=await f.service();await f.load(library);
 const before=await libraryFingerprint(path.join(f.root,'datasets'));
 const id=library.status().catalog.datasets.find(dataset=>dataset.name==='basic-file-delivery').id;
 library.downloadDataset(id);await library.catalog.pending;
 assert.equal(library.status().download.state,'FAILED');assert.match(library.status().download.error,/已在本地/);
 assert.equal(await libraryFingerprint(path.join(f.root,'datasets')),before);
 assert.ok(!f.requests.includes('datasets/sample/input/data.txt'));
});

test('checksum failures, cancellation and concurrent local edits retain local data and permit retry',async t=>{
 for(const mode of ['checksum','cancel','local-edit','busy']){
  const f=await fixture(t),library=await f.service();await f.load(library);
  const id=library.status().catalog.datasets.find(dataset=>dataset.name==='Synthetic mixed set').id;
  const before=await libraryFingerprint(path.join(f.root,'datasets'));
  let seen;const requested=new Promise(resolve=>{seen=resolve;});
  library.catalog.fetch=async(url,options)=>{
   if(!url.endsWith('datasets/sample/input/data.txt'))return f.fetchImpl(url,options);
   seen();
   if(mode==='checksum')return new Response('corrupted bytes');
   if(mode==='cancel')return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));
   if(mode==='local-edit')await writeFile(path.join(f.root,'datasets/keep-local.txt'),'user-owned');
   if(mode==='busy')library.catalog.canInstall=async()=>false;
   return f.fetchImpl(url,options);
  };
  library.downloadDataset(id);await requested;
  if(mode==='cancel')await library.cancelDownload();else await library.catalog.pending;
  assert.equal(library.status().download.state,mode==='cancel'?'CANCELLED':'FAILED');
  if(mode==='local-edit'){
   assert.equal(await readFile(path.join(f.root,'datasets/keep-local.txt'),'utf8'),'user-owned');
   await rm(path.join(f.root,'datasets/keep-local.txt'));
  }
  assert.equal(await libraryFingerprint(path.join(f.root,'datasets')),before);
  library.catalog.fetch=f.fetchImpl;library.catalog.canInstall=async()=>true;
  library.downloadDataset(id);await library.catalog.pending;assert.equal(library.status().download.state,'READY');
 }
});

test('byte progress follows streamed files, excludes failed attempts and includes verified cache hits',async t=>{
 const f=await fixture(t),library=await f.service();await f.load(library);
 const directory=library.status().catalog.datasets,inputName='datasets/sample/input/data.txt',bytes=f.files.get(inputName);
 let attempts=0;const samples=[];
 library.catalog.fetch=async(url,options)=>{
  if(!url.endsWith(inputName))return f.fetchImpl(url,options);
  const attempt=++attempts;samples.push(library.status().download.downloadedBytes);
  return {ok:true,body:(async function*(){
   yield bytes.subarray(0,3);samples.push(library.status().download.downloadedBytes);
   if(attempt===1)throw Error('Synthetic interrupted response');
   yield bytes.subarray(3);
  })()};
 };
 library.downloadDataset(directory.find(dataset=>dataset.name==='Synthetic mixed set').id);await library.catalog.pending;
 let status=library.status().download;
 assert.equal(status.state,'READY');assert.equal(attempts,2);assert.equal(samples[2],samples[0]);assert.equal(samples[1]-samples[0],3);
 assert.equal(status.downloadedBytes,status.totalBytes);assert.equal(status.phase,'COMPLETE');
 library.downloadDataset(directory.find(dataset=>dataset.name==='Synthetic second set').id);await library.catalog.pending;
 status=library.status().download;
 assert.equal(status.state,'READY');assert.equal(status.downloadedBytes,status.totalBytes);assert.equal(status.cachedBytes,status.totalBytes);
});

test('directory cards show download, progress, failure and actual local readiness separately',()=>{
 const remote={id:'dataset.fixture/v1',name:'<img src=x onerror=bad>',caseCount:2,downloadableCases:1,sourceOnlyCases:1,labelIds:['label.artifact-delivery/v1'],downloadBytes:1024};
 const library={catalog:{state:'READY',datasets:[remote]},download:{state:'IDLE'}},catalog={datasets:[],scoring:{readyCases:0,totalCases:0,labelIds:[]}},ui={selection:new Map(),datasetQuery:'',datasetFilter:'all'};
 let html=renderDatasets({catalog,ui,library});assert.match(html,/待下载/);assert.match(html,/下载题库/);assert.doesNotMatch(html,/data-dataset-detail=/);assert.doesNotMatch(html,/<img/);
 library.download={state:'DOWNLOADING',datasetId:remote.id,completedFiles:2,totalFiles:5};html=renderDatasets({catalog,ui,library});assert.match(html,/2 \/ 5 个文件/);assert.match(html,/取消下载/);assert.doesNotMatch(html,/data-dataset-detail=/);
 library.download={state:'FAILED',datasetId:remote.id,error:'<script>failed</script>'};html=renderDatasets({catalog,ui,library});assert.match(html,/重新下载/);assert.doesNotMatch(html,/<script>/);
 catalog.datasets=[{id:remote.id,name:'Local fixture',labelIds:[],cases:[{index:0,title:'Local task',scoringState:'UNAVAILABLE'}]}];
 html=renderDatasets({catalog,ui,library});assert.match(html,/选择题目/);assert.match(html,/本地 1 题/);assert.match(html,/0 题评分参考已就绪/);assert.doesNotMatch(html,/data-library-download=/);
 ui.datasetFilter='download';assert.doesNotMatch(renderDatasets({catalog,ui,library}),/class="dataset-card"/);
});

test('download cards show byte percentages and keep installation visibly in progress after the download finishes',()=>{
 const remote={id:'dataset.progress/v1',name:'Synthetic progress set',caseCount:1,downloadableCases:1,labelIds:[],downloadBytes:1024};
 const catalog={datasets:[]},ui={selection:new Map(),datasetQuery:'',datasetFilter:'all'};
 const library={catalog:{state:'READY',datasets:[remote]},download:{datasetId:remote.id,state:'DOWNLOADING',phase:'DOWNLOADING',completedFiles:0,totalFiles:1,downloadedBytes:256,totalBytes:1024}};
 let html=renderDatasets({catalog,ui,library});
 assert.match(html,/25%/);assert.match(html,/<progress[^>]*max="100"[^>]*value="25"/);assert.match(html,/256 B \/ 1\.0 KB/);
 library.download={...library.download,state:'INSTALLING',phase:'COPYING',completedFiles:1,downloadedBytes:1024,installation:{completed:12}};
 html=renderDatasets({catalog,ui,library});
 assert.match(html,/下载完成/);assert.match(html,/已复制 12 个文件/);assert.match(html,/<progress[^>]*aria-label="题库安装进度"/);
 assert.doesNotMatch(html,/<progress[^>]*value=/);assert.doesNotMatch(html,/100%/);
 library.download={...library.download,phase:'VALIDATING',installation:{completed:7,total:20}};
 html=renderDatasets({catalog,ui,library});
 assert.match(html,/正在校验题目/);assert.match(html,/7 \/ 20 题/);assert.match(html,/35%/);
 assert.match(html,/<progress[^>]*max="100"[^>]*value="35"/);
});

test('legacy local subsets keep their names, labels and selectable IDs without duplicate directory cards',()=>{
 const local={id:'dataset.harbor-synthetic-set/v1',name:'本地测试集',labelIds:['label.tool-code/v1'],cases:[{index:0,title:'已安装任务'}]};
 const remote={id:'dataset.benchdock-hashed/v1',name:'Synthetic-Set',caseCount:2,downloadableCases:1,sourceOnlyCases:1,labelIds:['label.artifact-delivery/v1']};
 const catalog={datasets:[local]},library={catalog:{state:'READY',datasets:[remote]}};
 const directory=datasetDirectory(catalog,library);assert.equal(directory.length,1);assert.equal(directory[0].id,local.id);assert.equal(directory[0].name,local.name);assert.deepEqual(directory[0].labelIds,local.labelIds);
 const html=renderDatasets({catalog,library,ui:{datasetQuery:'',selection:new Map()}});
 assert.match(html,/部分在本地/);assert.match(html,/data-dataset-detail="dataset.harbor-synthetic-set\/v1"/);assert.doesNotMatch(html,/data-library-download=/);
});

test('catalog download routes reject arbitrary locations and missing CSRF, then expose only installed selections',async t=>{
 const f=await fixture(t),library=await f.service();await f.load(library);
 const controller={env:{},jobs:{jobs:new Map()},status:async()=>({targets:[]})};
 const {server}=await startControlServer({root:f.root,port:0,controller,workbuddyController:controller,agentControllers:{},libraryService:library,modelSettingsFile:path.join(f.root,'models.env')});
 t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));const base='http://127.0.0.1:'+server.address().port;
 const {csrf}=await(await fetch(base+'/api/control/model-settings')).json();
 const post=(route,body,token=csrf)=>fetch(base+'/api/control/'+route,{method:'POST',headers:{'content-type':'application/json','x-workbench-token':token},body:JSON.stringify(body)});
 const id=library.status().catalog.datasets.find(dataset=>dataset.downloadableCases>0).id;
 assert.equal((await post('library/download',{datasetId:id},'wrong')).status,403);
 assert.equal((await post('library/download',{datasetId:id,url:'https://outside.invalid'})).status,409);
 assert.equal((await post('library/download',{datasetId:'../../private'})).status,409);
 assert.equal((await post('library/catalog',{path:'/tmp'})).status,409);
 const response=await post('library/download',{datasetId:id});assert.equal(response.status,200);await library.catalog.pending;
 const installed=await(await fetch(base+'/api/control/evaluation-catalog')).json();assert.ok(installed.datasets.some(dataset=>dataset.id===id));assert.doesNotMatch(JSON.stringify(installed),/must stay private/);
});
