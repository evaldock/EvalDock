import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import http from 'node:http';
import {readFile,writeFile,stat,open,symlink} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {temporary} from './support.mjs';
import {observationWriter,trimLog,pollInterval} from '../../workbench/lib/background-io.mjs';
import {startCollector} from '../../workbench/live-observation.mjs';

test('observation cache does not change for heartbeat-only updates, including after restart',async t=>{
 const root=await temporary(t),file=path.join(root,'cache/live.json');
 const write=observationWriter(file),value={version:1,observedAt:1,live:{active:true,observedAt:1,entries:[]},updates:[]};
 assert.equal(await write(value),true);const before=await stat(file),bytes=await readFile(file,'utf8');
 const heartbeat={...value,observedAt:2,live:{...value.live,observedAt:2}};
 assert.equal(await write(heartbeat),false);
 assert.equal(await observationWriter(file)(heartbeat),false);
 assert.equal((await stat(file)).mtimeMs,before.mtimeMs);assert.equal(await readFile(file,'utf8'),bytes);
 assert.equal(await write({...heartbeat,live:{...heartbeat.live,active:false,phase:'本轮已结束'}}),true);
});

test('diagnostic cap preserves the tail and existing append descriptor; never follows symlinks',async t=>{
 const root=await temporary(t),file=path.join(root,'service.log');await writeFile(file,'A'.repeat(100)+'TAIL');
 const appender=await open(file,'a');t.after(()=>appender.close());const ino=(await stat(file)).ino;
 assert.equal(await trimLog(file,{maxBytes:80,keepBytes:20}),true);
 assert.equal((await stat(file)).ino,ino);assert.equal((await stat(file)).size,20);
 await appender.write('NEXT');assert.ok((await readFile(file,'utf8')).endsWith('TAILNEXT'));
 assert.equal(await trimLog(file,{maxBytes:80,keepBytes:20}),false);
 const link=path.join(root,'link');await symlink(file,link);
 await assert.rejects(trimLog(link,{maxBytes:20,keepBytes:5}));
 assert.equal((await stat(file)).size,24);
 assert.equal(await trimLog(path.join(root,'missing')),false);
});

async function until(predicate){for(let i=0;i<200;i++){if(await predicate())return;await delay(10);}throw Error('condition timed out');}
test('collector finalizes once, polls metadata without rewriting, and wakes for a new run',async t=>{
 const root=await temporary(t),cancel=new AbortController();
 let activity={active:true,revision:'1'},state='RUNNING',runId='run-one',fullReads=0,metadataReads=0;
 const server=http.createServer((req,res)=>{
  res.setHeader('content-type','application/json');
  if(req.url==='/api/control/activity'){metadataReads++;res.end(JSON.stringify(activity));}
  else if(req.url==='/api/control/status'){fullReads++;res.end(JSON.stringify({jobs:[{targetId:'agent',runId,state,events:[]}],activeSessions:[],endpoint:'http://127.0.0.1:1'}));}
  else{res.statusCode=404;res.end('{}');}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const task=startCollector({root,home:root,port:server.address().port,signal:cancel.signal,interval:()=>15});
 t.after(async()=>{cancel.abort();await task;await new Promise(resolve=>server.close(resolve));});
 const file=path.join(root,'var/workbench/cache/live-observation.json');
 const snapshot=()=>readFile(file,'utf8').then(JSON.parse).catch(()=>null);
 await until(async()=> (await snapshot())?.live?.active);
 state='SUCCEEDED';activity={active:false,revision:'2'};
 await until(async()=> (await snapshot())?.live?.active===false);
 // A status response can observe completion after its activity request saw the old revision.
 // Let that transition settle before measuring steady idle polling.
 const transitionPolls=metadataReads;await until(()=>metadataReads>=transitionPolls+2);
 const reads=fullReads,baseline=await stat(file),polls=metadataReads;
 await until(()=>metadataReads>=polls+3);
 assert.equal(fullReads,reads);assert.equal((await stat(file)).mtimeMs,baseline.mtimeMs);
 state='RUNNING';runId='run-two';activity={active:true,revision:'3'};
 await until(async()=> (await snapshot())?.live?.runId==='run-two');
 assert.ok(fullReads>reads);
 cancel.abort();await task;
 await assert.rejects(stat(path.join(root,'var/workbench/control/live-observation.pid')),{code:'ENOENT'});
 assert.equal(pollInterval(false),30000);assert.equal(pollInterval(true),5000);
});

test('terminal Trace remains visible without heartbeat writes; active liveness uses IPC timestamp',async()=>{
 const {default:vm}=await import('node:vm');
 const source=await readFile('workbench/design-prototypes/live-ui.js','utf8');
 const context=vm.createContext({document:{addEventListener(){}},controlSnapshot:{jobs:[{runId:'run',targetId:'agent',state:'SUCCEEDED',progress:{active:false}}],observationCheckedAt:Date.now()},Date});
 vm.runInContext(source,context);
 vm.runInContext("liveSnapshot={observedAt:1,live:{active:false,runId:'run',agentId:'agent'},updates:[{agentId:'agent',run:{id:'run',status:'COMPLETED'},runtime:{trace:'retained'}}]}",context);
 assert.equal(vm.runInContext('liveUpdatesFor([])[0].runtime.trace',context),'retained');
 vm.runInContext("controlSnapshot.jobs[0].state='RUNNING';controlSnapshot.jobs[0].progress.active=true;liveSnapshot.live.active=true;liveSnapshot.updates[0].run.status='RUNNING'",context);
 assert.equal(vm.runInContext('liveUpdatesFor([]).length',context),1);
 context.controlSnapshot.observationCheckedAt=1;
 assert.equal(vm.runInContext('liveUpdatesFor([]).length',context),0);
});

test('lightweight activity revision is stable while idle and changes with job state',async()=>{
 const {DshControl}=await import('../../workbench/lib/dsh-control.mjs');
 const control=new DshControl('/unused');
 const job={id:'job',state:'RUNNING',events:[]};
 control.jobs={jobs:new Map([['job',job]])};control.descriptor={};
 control.externalRuns={active:async()=>[],archives:async()=>[]};
 const before=await control.activity();assert.equal(before.active,true);
 assert.deepEqual(await control.activity(),before);
 job.state='SUCCEEDED';job.endedAt='2026-09-16T00:00:00Z';
 const after=await control.activity();assert.equal(after.active,false);assert.notEqual(after.revision,before.revision);
 assert.deepEqual(await control.activity(),after);
});

for(const failedSession of [null,'session-2'])test(`collector keeps concurrent histories isolated (${failedSession?'one history fails':'all histories succeed'})`,async t=>{
 const root=await temporary(t),currentCases=[1,2,3].map(ordinal=>({ordinal,caseId:'case-'+ordinal})),queried=[];
 const job={runId:'parallel',targetId:'agent',state:'RUNNING',events:[],progress:{active:true,current:currentCases[0],currentCases,total:3}};
 const server=http.createServer(async(req,res)=>{
  res.setHeader('content-type','application/json');
  if(req.url==='/api/control/activity')return res.end(JSON.stringify({active:true,revision:'parallel'}));
  if(req.url==='/api/control/status')return res.end(JSON.stringify({jobs:[job],endpoint:'http://127.0.0.1:'+server.address().port,activeSessions:currentCases.map(c=>({id:'session-'+c.ordinal,title:c.caseId,cwd:`/var/parallel/parallel.c${c.ordinal}/workspaces`}))}));
  if(req.url==='/api/session.list')return res.end(JSON.stringify({result:{ok:true,value:{items:[]}}}));
  if(req.url==='/api/session.history'){
   let body='';for await(const chunk of req)body+=chunk;const id=JSON.parse(body).payload.sessionId;queried.push(id);
   if(id===failedSession){res.statusCode=503;return res.end('{}');}
   return res.end(JSON.stringify({result:{ok:true,value:{events:[{type:'assistant/message',seq:1,data:{message:{content:[{type:'text',text:'answer from '+id}]}}}]}}}));
  }
  res.statusCode=404;res.end('{}');
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 await startCollector({root,home:root,port:server.address().port,once:true});
 const value=JSON.parse(await readFile(path.join(root,'var/workbench/cache/live-observation.json'),'utf8'));
 assert.equal(value.liveCases.length,3);
 for(const c of value.liveCases)assert.equal(c.error,c.sessionId===failedSession?'DSH_WEB_HTTP_503':null,`session ${c.sessionId}: ${c.error}`);
 assert.deepEqual(queried.sort(),['session-1','session-2','session-3']);
 assert.equal(value.updates[0].run.cases.length,3);
 for(const c of value.liveCases){assert.equal(c.sessionId,'session-'+c.ordinal);if(c.sessionId===failedSession){assert.deepEqual(c.entries,[]);assert.equal(c.phase,'实时观测暂不可用');}else assert.equal(c.entries[0].text,'answer from '+c.sessionId);}
 const writer=observationWriter(path.join(root,'var/workbench/cache/live-observation.json'));
 assert.equal(await writer({...value,observedAt:Date.now()+100,live:{...value.live,observedAt:Date.now()+100},liveCases:value.liveCases.map(c=>({...c,observedAt:Date.now()+100}))}),false);
});
