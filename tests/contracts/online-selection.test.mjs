import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,cp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {BenchDockLibrary} from '../../workbench/lib/benchdock-library.mjs';
import {OnlineSelection} from '../../workbench/lib/online-selection.mjs';
import {evaluationCatalog} from '../../workbench/lib/evaluation-config.mjs';
import {libraryFingerprint} from '../../desktop/workspace.mjs';
import {loadDatasetCase} from '../../dist/src/datasets/loader.js';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fixture(t){
  const root=await mkdtemp(path.join(os.tmpdir(),'evaldock-online-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await cp('dist',path.join(root,'dist'),{recursive:true});await cp('datasets',path.join(root,'datasets'),{recursive:true});await mkdir(path.join(root,'config'));await writeFile(path.join(root,'package.json'),'{"type":"module"}');
  const rows=Array.from({length:10},(_,i)=>({schema:'benchdock.catalog/v1',task_id:'synthetic-'+i,subset:'Synthetic large set',title:'Synthetic task '+i,prompt:'Copy input/data.txt to output/answer.txt.',distribution:'bundled',environment_status:'inputs_bundled_python_required',inputs:[{path:'datasets/fixture-'+i+'/data.txt',destination:'input/data.txt',bytes:1,sha256:sha(Buffer.from('x'))}],license_files:[]}));
  rows.push({schema:'benchdock.catalog/v1',task_id:'source-only',subset:'Synthetic source set',distribution:'source_reference'});
  const files=new Map(rows.slice(0,10).map((row,i)=>['datasets/fixture-'+i+'/data.txt',Buffer.from('x')]));
  files.set('LICENSE',Buffer.from('Synthetic license'));files.set('NOTICE.md',Buffer.from('Synthetic notice'));files.set('catalog.jsonl',Buffer.from(rows.map(row=>JSON.stringify(row)).join('\n')+'\n'));files.set('private/reference.json',Buffer.from('PRIVATE SYNTHETIC REFERENCE'));
  const manifest=Buffer.from([...files].map(([name,bytes])=>JSON.stringify({path:name,bytes:bytes.length,sha256:sha(bytes)})).join('\n')+'\n');files.set('FILES.jsonl',manifest);
  await writeFile(path.join(root,'config/benchdock-pilot.json'),JSON.stringify({schema:'evaldock.benchdock-profile/v1',repo_id:'EvalDock/BenchDock',revision:'c'.repeat(40),manifest_sha256:sha(manifest),tasks:[{task_id:'synthetic-0',task_path:'datasets/fixture-0/task.json',capabilityLabels:['artifact-delivery'],environment:{platform:'portable',timeoutSeconds:30,allowedEdits:['output/**'],dependencies:[]}}]}));
  const requests=[];
  const library=new BenchDockLibrary({root,fetchImpl:async url=>{const name=decodeURIComponent(url.split('/'+'c'.repeat(40)+'/')[1]);requests.push(name);return new Response(files.get(name),{status:files.has(name)?200:404});}});await library.init();t.after(()=>library.close());
  let count=2,seenInput;
  const selection=new OnlineSelection({root,library,inspectTarget:async()=>({target_type:'FULL_AGENT',tools:[],tool_delta:{},permission_preset:'UNKNOWN',sandbox_mode:'UNKNOWN',probe:{},limitations:[]}),matcherFactory:()=>({select:async input=>{seenInput=input;const candidate=input.availableDatasets.find(item=>item.name==='Synthetic large set');return {model:'synthetic-planner',selectedDatasets:[{datasetId:candidate.datasetId,caseCount:count,reason:'Synthetic coverage'}]};}})});
  library.selection=selection;
  const start=()=>selection.start({agentKind:'pi',targetId:'fixture-pi',evaluationConfig:{mode:'FULL',selection:{kind:'COUNT',caseCount:count}}});
  return {root,library,selection,requests,start,setCount:n=>{count=n;},input:()=>seenInput};
}
test('full directory matching installs only needed Cases, preserves references, and extends partial subsets',async t=>{
  const f=await fixture(t),reference=await readFile(path.join(f.root,'datasets/basic-file-delivery/case-001/private/final.json'));
  assert.equal(f.start().state,'PREPARING');await f.selection.pending;
  assert.equal(f.selection.status().state,'READY');assert.equal(f.selection.status().preparedCases,2);
  assert.equal(f.input().availableDatasets.find(item=>item.name==='Synthetic large set').availableCaseCount,10);
  assert.ok(!f.input().availableDatasets.some(item=>item.name==='Synthetic source set'));assert.doesNotMatch(JSON.stringify(f.input().availableDatasets),/PRIVATE SYNTHETIC|Copy input/);
  assert.equal(f.requests.filter(name=>name.endsWith('/data.txt')).length,2);assert.ok(!f.requests.some(name=>name.includes('private')));
  let catalog=await evaluationCatalog(f.root),subset=catalog.datasets.find(item=>item.name==='Synthetic large set');assert.equal(subset.cases.length,2);assert.equal(subset.cases[0].scoringState,'UNAVAILABLE');
  const first=(await readFile(path.join(f.root,'datasets',subset.id.slice(8).replace('/v1',''),'delivery-profile.json'))).toString();
  f.setCount(3);f.start();await f.selection.pending;assert.equal(f.selection.status().state,'READY');assert.equal(f.selection.status().preparedCases,1);
  catalog=await evaluationCatalog(f.root);subset=catalog.datasets.find(item=>item.id===subset.id);assert.equal(subset.cases.length,3);assert.equal(f.requests.filter(name=>name.endsWith('/data.txt')).length,3);
  for(let i=0;i<3;i++)await loadDatasetCase({datasetsRoot:path.join(f.root,'datasets'),datasetId:subset.id,labelIds:subset.labelIds,caseIndex:i});
  assert.equal((await readFile(path.join(f.root,'datasets',subset.id.slice(8).replace('/v1',''),'delivery-profile.json'))).toString(),first);
  assert.deepEqual(await readFile(path.join(f.root,'datasets/basic-file-delivery/case-001/private/final.json')),reference);
  assert.equal((await readdir(path.join(f.root,'var/online-selection'))).length,2);
});
test('invalid plans, busy environments and cancellation stop before installing',async t=>{
  const f=await fixture(t),before=await libraryFingerprint(path.join(f.root,'datasets'));
  f.selection.matcherFactory=()=>({select:async()=>({selectedDatasets:[{datasetId:'unknown',caseCount:1}]})});f.start();await f.selection.pending;
  assert.equal(f.selection.status().state,'FAILED');assert.equal(await libraryFingerprint(path.join(f.root,'datasets')),before);
  f.library.canInstall=async()=>false;f.start();await f.selection.pending;assert.equal(f.selection.status().state,'FAILED');
  f.library.canInstall=async()=>true;
  let entered;const waiting=new Promise(resolve=>{entered=resolve;});
  f.selection.matcherFactory=()=>({select:async({signal})=>{entered();await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}});
  f.start();await waiting;await f.selection.cancel();assert.equal(f.selection.status().state,'CANCELLED');assert.equal(await libraryFingerprint(path.join(f.root,'datasets')),before);
  assert.throws(()=>f.selection.start({agentKind:'pi',targetId:'fixture',evaluationConfig:{mode:'FULL',selection:{kind:'SELECTED',items:[{datasetId:'unknown',caseIndices:[0]}]}}}),/仅支持自动/);
});
