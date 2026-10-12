import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {open, mkdir, readFile, lstat, writeFile, symlink, chmod} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {temporary, question, json} from './support.mjs';
import {loadDatasetCase, resolveDatasetSeedEntries} from '../../dist/src/datasets/loader.js';
import {seedEnvironment} from '../../dist/src/runtime/environment.js';
import {seedWorkspace} from '../../adapters/shared/evidence.mjs';
import {freezeDatasetInput, copyDatasetInput} from '../../dist/src/storage/dataset-inputs.js';
import {captureFileSnapshot} from '../../dist/observer-lab/adapters/filesystem/sensor.js';
import {freezeConfig} from '../../dist/src/platform/config.js';
import {FileArtifactStore} from '../../dist/src/storage/artifacts.js';

async function fixture(t, size = 106319390) {
  const root = await temporary(t), {dir,q} = await question(root);
  const file=path.join(dir,'input/data.txt');
  const handle=await open(file,'w');
  const chunk=Buffer.alloc(64*1024,0x63), hash=createHash('sha256');
  try {for(let done=0;done<size;){const data=chunk.subarray(0,Math.min(chunk.length,size-done));await handle.write(data);hash.update(data);done+=data.length;}}finally{await handle.close();}
  q.inputs[0].sha256=hash.digest('hex'); await json(path.join(dir,'question.json'),q);
  return {root,dir,file,q};
}
const load=(root,more={})=>loadDatasetCase({datasetsRoot:root,datasetId:'dataset.example/v1',labelIds:['label.contract/v1'],...more});

test('101 MiB public input stays outside records and is copied/hash-verified without raising 64 MiB artifacts',async t=>{
  const {root,q,file}=await fixture(t);
  const data=await load(root);
  const serialized=JSON.stringify(data);
  assert.ok(serialized.length<10_000);assert.ok(!serialized.includes(root));
  assert.equal(data.seedEntries.find(e=>e.entryType==='FILE').encoding,'file');
  const workspace=path.join(root,'workspace');await mkdir(workspace);
  const resources=await seedEnvironment(workspace,resolveDatasetSeedEntries(data));
  await chmod(path.join(workspace,'input'),0o755);
  const result=resources.find(e=>e.entryType==='FILE');assert.equal(result.byteLength,106319390);assert.equal(result.sha256,q.inputs[0].sha256);
  const destination=path.join(workspace,'input/data.txt');
  assert.notEqual((await lstat(destination)).ino,(await lstat(file)).ino);
  const captured=await captureFileSnapshot({snapshotId:'test.before',attemptId:'attempt.test',phase:'BEFORE',rootPath:workspace,rootBinding:'attempt.workspace',maxFileBytes:64*1024*1024});
  assert.equal(captured.completeness,'COMPLETE');assert.equal(captured.entries.find(e=>e.portablePath==='input/data.txt').contentDigest.value,q.inputs[0].sha256);
  const store=new FileArtifactStore({artifactRoot:path.join(root,'artifacts'),runRoot:path.join(root,'records'),runId:'run.test',scope:{targetId:'agent.test'},maxArtifactBytes:64*1024*1024});
  const committed=await store.commit({idempotencyKey:'grading',cancellationToken:{isCancellationRequested:false}},serialized,{artifactId:'grading-context.test',scope:{targetId:'agent.test'},artifactType:'GRADING_CONTEXT',logicalName:'grading-context.json',mediaType:'application/json',producerVersion:'test',createdAt:'2026-10-09T00:00:00Z',sensitivity:'RESTRICTED',redactionState:'NOT_REQUIRED'});
  assert.equal(committed.status,'SUCCEEDED');assert.ok(committed.value.byteLength<10000);
  const shared=path.join(root,'adapter-workspace');await seedWorkspace(shared,resolveDatasetSeedEntries(data));
  assert.equal((await lstat(path.join(shared,'input/data.txt'))).size,106319390);
});

test('public input quota is independent, configurable and checked before materialization',async t=>{
  const {root}=await fixture(t,300*1024);
  await assert.rejects(load(root,{maxDatasetInputBytes:256*1024}),/maxDatasetInputBytes/);
  const config=await freezeConfig({cwd:root,configId:'config.test',invocationId:'invocation.test',createdAt:'2026-10-09T00:00:00Z',evaldockVersion:'test',environment:{EVALDOCK_MAX_DATASET_INPUT_BYTES:'536870912'},cli:{targetRoot:path.join(root,'target')}});
  assert.equal(config.maxDatasetInputBytes,536870912);assert.equal(config.maxArtifactBytes,67108864);assert.equal(config.fieldSources.maxDatasetInputBytes,'ENVIRONMENT');
  await assert.rejects(freezeConfig({cwd:root,configId:'config.test',invocationId:'invocation.test',createdAt:'2026-10-09T00:00:00Z',evaldockVersion:'test',environment:{EVALDOCK_MAX_DATASET_INPUT_BYTES:'0'},cli:{targetRoot:path.join(root,'target')}}),/maxDatasetInputBytes/);
});

test('changed large inputs and unbound frozen file seeds fail closed without partial files',async t=>{
  const {root,file}=await fixture(t,300*1024);const data=await load(root);
  const entries=resolveDatasetSeedEntries(data), entry=entries.find(e=>e.sourceFile);
  await assert.rejects(async()=>resolveDatasetSeedEntries(JSON.parse(JSON.stringify(data))),/Unbound/);
  await assert.rejects(async()=>resolveDatasetSeedEntries(data,data.seedEntries.map(e=>e.encoding==='file'?{...e,contentDigest:{...e.contentDigest,value:'0'.repeat(64)}}:e)),/changed/);
  const h=await open(file,'r+');await h.write(Buffer.from('changed'),0,7,0);await h.close();
  const output=path.join(root,'copied');
  await assert.rejects(copyDatasetInput(entry.sourceFile,output),/digest changed/);
  await assert.rejects(lstat(output),{code:'ENOENT'});
  const existing=path.join(root,'existing');await writeFile(existing,'keep');
  await assert.rejects(copyDatasetInput(entry.sourceFile,existing),{code:'EEXIST'});assert.equal(await readFile(existing,'utf8'),'keep');
});

test('public input loader rejects symlink/escaped sources and preserves small inline seeds',async t=>{
  const root=await temporary(t),{dir,q}=await question(root),outside=path.join(root,'private.txt');await writeFile(outside,'secret');
  const small=await load(root);assert.equal(small.seedEntries.find(e=>e.entryType==='FILE').encoding,'base64');
  await symlink(outside,path.join(dir,'input/link.txt'));
  await assert.rejects(freezeDatasetInput(path.join(dir,'input/link.txt'),path.join(dir,'input')),/outside|regular/);
});
