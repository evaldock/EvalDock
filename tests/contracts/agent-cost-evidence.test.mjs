import {pythonExecutable} from './python-support.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,writeFile,symlink,chmod} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {temporary} from './support.mjs';
import {Capture,runProcess} from '../../adapters/shared/capture.mjs';
import {piEvent} from '../../adapters/pi/adapter.mjs';
import {createHermesAdapter,hermesEvent} from '../../adapters/hermes/adapter.mjs';
import {createOpenClawAdapter,openClawEvent} from '../../adapters/openclaw/adapter.mjs';
import {langGraphEvent} from '../../adapters/langgraph/adapter.mjs';
import {normalizeUsage} from '../../adapters/shared/capture.mjs';
import {buildTrace} from '../../adapters/shared/evidence.mjs';
import {normalizedEvent} from '../../adapters/shared/capture.mjs';
import {projectTraceOverview} from '../../dist/src/reporting/trace-overview.js';
import {dshSessionsToProbeJsonl} from '../../dist/src/runtime/dsh-session-trace.js';

test('Pi preserves each completed response usage once, including tool turns and cache',()=>{
 const c=new Capture('pi');
 const message={id:'response-1',role:'assistant',content:[],usage:{input:100,output:8,cacheRead:60,totalTokens:108}};
 piEvent({type:'message_end',message},c);piEvent({type:'message_end',message},c);
 piEvent({type:'message_end',message:{...message,id:'response-2',usage:{input:110,output:4,totalTokens:114}}},c);
 piEvent({type:'agent_end'},c);
 assert.equal(c.result.usage.inputTokens,210);assert.equal(c.result.usage.outputTokens,12);
 assert.equal(c.result.usage.cacheReadTokens,60);assert.equal(c.result.usage.totalTokens,222);
 assert.equal(c.usageEvidence.counterScope,'PER_RESPONSE');assert.equal(c.usageEvidence.aggregation,'SUM');
 assert.equal(c.usageEvidence.records,2);assert.equal(c.usageEvidence.fieldCoverage.cacheReadTokens,1);
});

test('WorkBuddy reads only the owned native archive, deduplicates usage mirrors and rejects symlinks',async t=>{
 const {readWorkBuddyUsage}=await import('../../adapters/workbuddy/usage.mjs');
 const root=await temporary(t),cwd=path.join(root,'workspace with spaces'),historyRoot=path.join(root,'projects');
 const dir=path.join(historyRoot,cwd.replace(/^\//,'').replaceAll('/','-'));await mkdir(dir,{recursive:true});
 const row={type:'function_call',id:'call-1',sessionId:'owned',cwd,providerData:{messageId:'response-1',usage:{inputTokens:100,outputTokens:5,totalTokens:105,inputTokensDetails:[{cached_tokens:80}]}},content:'private text must not be copied'};
 const other={...row,id:'foreign',sessionId:'other',providerData:{messageId:'other',usage:{inputTokens:9999}}};
 const second={...row,id:'call-2',providerData:{messageId:'response-2',rawUsage:{inputTokens:140,outputTokens:9,totalTokens:149}}};
 await writeFile(path.join(dir,'owned.jsonl'),[row,{...row,id:'mirror'},second,other].map(JSON.stringify).join('\n'));
 const r=await readWorkBuddyUsage({cwd,sessionId:'owned',historyRoot});
 assert.equal(r.usage.inputTokens,240);assert.equal(r.usage.cacheReadTokens,80);assert.equal(r.records,2);assert.equal(r.usage.totalTokens,254);
 assert.equal(r.counterScope,'PER_RESPONSE');assert.equal(r.aggregation,'SUM');assert.equal(r.fieldCoverage.cacheReadTokens,1);
 assert.ok(!JSON.stringify(r).includes('private text'));assert.ok(!JSON.stringify(r).includes('9999'));
 await symlink(path.join(dir,'owned.jsonl'),path.join(dir,'linked.jsonl'));
 assert.equal((await readWorkBuddyUsage({cwd,sessionId:'linked',historyRoot})).usage,null);
 assert.equal((await readWorkBuddyUsage({cwd,sessionId:'../owned',historyRoot})).usage,null);
});

test('LangGraph sums distinct completed AI messages and replaces changed mirrors, never just the last response',()=>{
 const c=new Capture('langgraph');
 for(const [messageId,input] of [['a',100],['b',140],['b',150],['a',100]])langGraphEvent({type:'session/usage',data:{messageId,usage:{input_tokens:input,output_tokens:5,total_tokens:input+5}}},c);
 langGraphEvent({type:'runtime/completed'},c);
 assert.deepEqual(c.result.usage,{inputTokens:250,outputTokens:10,totalTokens:260});
 assert.equal(c.usageEvidence.records,2);assert.equal(c.usageEvidence.counterScope,'PER_RESPONSE');assert.equal(c.usageEvidence.aggregation,'SUM');
});

test('Hermes and OpenClaw keep the latest native session total without summing cumulative snapshots',()=>{
 for(const [kind,event,row] of [
  ['hermes',hermesEvent,n=>({type:'result',exit_code:0,text:'done',tokens:{input:n,output:10,total:n+10}})],
  ['openclaw',openClawEvent,n=>({type:'runtime/result',data:{ok:true,status:'ok',final:'done',usage:{input:n,output:10,totalTokens:n+10}}})]
 ]){
  const c=new Capture(kind);event(row(100),c);event(row(240),c);event(row(240),c);
  assert.equal(normalizeUsage(c.result.usage).totalTokens,250);
  assert.equal(c.usageEvidence.counterScope,'SESSION_TOTAL');assert.equal(c.usageEvidence.aggregation,'NONE');
 }
});

test('OpenClaw uses a native session total once, or explicitly sums the owned response archive when it is absent',async t=>{
 const root=await temporary(t),cli=path.join(root,'fake-cli.mjs');
 await writeFile(cli,`import path from 'node:path';import {mkdirSync} from 'node:fs';import {DatabaseSync} from 'node:sqlite';
 const state=process.argv[process.argv.indexOf('--state-dir')+1];const file=path.join(state,'agents/main/agent/openclaw-agent.sqlite');mkdirSync(path.dirname(file),{recursive:true});const db=new DatabaseSync(file);db.exec('CREATE TABLE transcript_events(session_id TEXT,seq INTEGER,event_json TEXT)');const put=db.prepare('INSERT INTO transcript_events VALUES(?,?,?)');
 for(const [seq,id,input] of [[1,'a',100],[2,'b',140],[3,'b',140]])put.run('owned',seq,JSON.stringify({type:'message',id,timestamp:'2026-10-01T00:00:00Z',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'done'}],usage:{input,output:5,totalTokens:input+5}}}));
 put.run('foreign',1,JSON.stringify({type:'message',id:'other',timestamp:'2026-10-01T00:00:00Z',message:{role:'assistant',usage:{input:9999}}}));db.close();console.log(JSON.stringify({ok:true,status:'ok',final:'done',sessionId:'owned',lastCallUsage:{input:140,output:5,totalTokens:145},...state.includes('with-total')?{usage:{input:240,output:10,totalTokens:250}}:{}}));`);
 const adapter=createOpenClawAdapter({node:process.execPath,executable:cli,model:'synthetic'});
 for(const name of ['with-total','without-total']){
  const caseDirectory=path.join(root,name);await mkdir(caseDirectory);
  const r=await adapter.run({context:{env:{PATH:process.env.PATH}},caseDirectory,cwd:root,prompt:'synthetic',deadlineMs:10000});
  assert.equal(r.error,null);assert.equal(normalizeUsage(r.result.usage).totalTokens,250);
  assert.equal(r.usageEvidence.counterScope,name==='with-total'?'SESSION_TOTAL':'PER_RESPONSE');
  assert.equal(r.usageEvidence.aggregation,name==='with-total'?'NONE':'SUM');
  if(name==='without-total')assert.equal(r.usageEvidence.records,2);
 }
});

test('LangGraph captures native message usage without repeated checkpoint snapshots',()=>{
 const script=`import sys,json\nsys.path.insert(0,'adapters/langgraph')\nimport runner\nrows=[]\nrunner.emit=lambda kind,data:rows.append((kind,data))\ne=runner.Evidence()\nm={'type':'ai','id':'response-1','content':'done','usage_metadata':{'input_tokens':100,'output_tokens':9,'total_tokens':109,'input_token_details':{'cache_read':60}}}\ne.message(m)\ne.message(m)\nprint(json.dumps([data for kind,data in rows if kind=='session/usage']))`;
 const r=spawnSync(pythonExecutable,['-c',script],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);
 const rows=JSON.parse(r.stdout);assert.equal(rows.length,1);assert.equal(rows[0].usage.input_tokens,100);
});

test('shared trace retains actual execution interval and exposes session totals in report preview',()=>{
 const capture={sessionId:'owned',queue:[],final:'done',result:{stopReason:'end_turn',usage:{inputTokens:100,outputTokens:9,cacheReadTokens:60}},execution:{startedAt:'2026-10-01T00:00:02.000Z',endedAt:'2026-10-01T00:00:04.000Z',durationMs:2000,scope:'AGENT_PROCESS'}};
 const trace=buildTrace({scope:{targetId:'pi',runId:'run',caseId:'case',attemptId:'attempt'},capture,before:{entries:[],truncated:false},after:{entries:[],truncated:false},delivery:{files:[],artifacts:[],bodies:new Map()},startedAt:'2026-10-01T00:00:00.000Z',endedAt:'2026-10-01T00:00:10.000Z',agent:{kind:'pi',sourceType:'PI_PROBE',externalSchema:'pi.json-events/v1',normalizeEvent:normalizedEvent,blindSpots:[]}});
 const end=trace.entries.find(e=>e.content?.data?.event?.type==='session/completion').content.data.event.data;
 assert.equal(end.execution.durationMs,2000);assert.equal(projectTraceOverview(trace).usage.input,100);
});

test('process timing ends before descendant cleanup and remains separate from capture window',async()=>{
 const r=await runProcess({command:process.execPath,args:['-e',`process.stdout.write(JSON.stringify({type:'done'})+'\\n')`],cwd:process.cwd(),env:process.env,deadlineMs:5000,capture:new Capture('timing'),onEvent:(_row,c)=>{c.result={stopReason:'end_turn'};}});
 assert.equal(r.cleanup,'STOPPED');assert.ok(Number.isFinite(r.execution.durationMs));
 assert.equal(Date.parse(r.execution.endedAt)-Date.parse(r.execution.startedAt),r.execution.durationMs);
});

test('Hermes archive reads session counters without deriving unknown fields or leaking other sessions',async t=>{
 const root=await temporary(t),db=path.join(root,'state.db');
 const seed=`import sqlite3,sys\nc=sqlite3.connect(sys.argv[1])\nc.execute('CREATE TABLE sessions(id TEXT,ended_at REAL,input_tokens INTEGER,output_tokens INTEGER,cache_read_tokens INTEGER)')\nc.execute('CREATE TABLE messages(id INTEGER,session_id TEXT,role TEXT,tool_call_id TEXT,tool_calls TEXT,tool_name TEXT,content TEXT,timestamp REAL,finish_reason TEXT)')\nc.execute('INSERT INTO sessions VALUES(?,?,?,?,?)',('owned',20,100,5,60))\nc.execute('INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?)',(1,'owned','assistant',None,None,None,'done',20,'stop'))\nc.commit()`;
 assert.equal(spawnSync(pythonExecutable,['-c',seed,db],{encoding:'utf8'}).status,0);
 const r=spawnSync(pythonExecutable,['adapters/hermes/session-evidence.py',db,'--session-archive'],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);
 const data=JSON.parse(r.stdout);assert.deepEqual(data.usage,{input_tokens:100,output_tokens:5,cache_read_tokens:60});
 assert.equal(data.usage.reasoning_tokens,undefined);
});

test('report token projection prefers session totals to duplicate response mirrors and preserves missing fields',()=>{
 const event=(id,type,data,sessionId='owned')=>({id,layer:'AGENT',content:{data:{sessionId,event:{type,data}}}});
 const trace={entries:[event('m','assistant/message',{message:{id:'m'},usage:{inputTokens:70,outputTokens:3}}),event('mirror','assistant/message',{message:{id:'m'},usage:{inputTokens:70,outputTokens:3}}),event('end','session/completion',{usage:{inputTokens:100,outputTokens:8}}),event('other','session/completion',{usage:{inputTokens:20}},'second')]};
 assert.deepEqual(projectTraceOverview(trace).usage,{input:120,output:8,reasoning:null,cacheRead:null});
});

test('Hermes streaming completion enriches omitted cache and reasoning counters from the owned DB',async t=>{
 const root=await temporary(t),cli=path.join(root,'hermes'),caseDirectory=path.join(root,'case');await mkdir(caseDirectory);
 const python=spawnSync(pythonExecutable,['-c','import sys; print(sys.executable)'],{encoding:'utf8'});assert.equal(python.status,0,python.stderr);
 await symlink(python.stdout.trim(),path.join(root,'python'));
 await writeFile(cli,`#!/usr/bin/python3\nimport os,json,sqlite3\nfrom pathlib import Path\nc=sqlite3.connect(str(Path(os.environ['HERMES_HOME'])/'state.db'))\nc.execute('CREATE TABLE sessions(id TEXT,input_tokens INTEGER,output_tokens INTEGER,cache_read_tokens INTEGER,cache_write_tokens INTEGER,reasoning_tokens INTEGER)')\nc.execute('INSERT INTO sessions VALUES(?,?,?,?,?,?)',('owned',100,5,80,0,2))\nc.commit();c.close()\nprint(json.dumps({'type':'system','session_id':'owned'}))\nprint(json.dumps({'type':'result','session_id':'owned','exit_code':0,'text':'done','tokens':{'input':100,'output':5,'total':185}}))\n`);await chmod(cli,0o700);
 const adapter=createHermesAdapter({executable:cli,model:'synthetic'});
 const r=await adapter.run({context:{env:process.env,protocol:{id:'hermes.stream-json/v1',flags:['--format']}},caseDirectory,cwd:root,prompt:'synthetic',deadlineMs:5000});
 const u=normalizeUsage(r.result.usage);assert.equal(u.cacheReadTokens,80);assert.equal(u.reasoningTokens,2);
 assert.equal(u.totalTokens,185);assert.equal(r.usageEvidence.inputTokenBasis,'EXCLUDES_CACHE');assert.equal(r.error,null);
 assert.equal(r.usageEvidence.counterScope,'SESSION_TOTAL');assert.equal(r.usageEvidence.aggregation,'NONE');
});

test('DSH exposes an explicit per-response sum without altering native events or counting mirrors and token deltas',()=>{
 const header={type:'session',id:'owned',cwd:'/case'};
 const message=(seq,id,usage)=>({type:'assistant/message',seq,time:1000+seq*100,data:{turn:1,step:seq,message:{role:'assistant',id,content:[]},usage}});
 const first={inputTokens:120,outputTokens:8,cacheReadTokens:80,totalTokens:208};
 const events=[{type:'turn/start',seq:1,time:1000,data:{turn:1}},message(2,'response-1',first),message(3,'response-1',first),{type:'assistant/chunk',seq:4,time:1400,data:{turn:1,step:4,chunk:{type:'usage',usage:{inputTokens:9999}}}},message(5,'response-2',{inputTokens:110,outputTokens:10,cacheReadTokens:40,totalTokens:160}),{type:'turn/end',seq:6,time:2000,data:{turn:1,reason:{kind:'completed'}}}];
 const rows=dshSessionsToProbeJsonl({sessions:[{sessionId:'owned',jsonl:[header,...events].map(JSON.stringify).join('\n')}],sourceRunId:'run',pid:1,startedAt:'1970-01-01T00:00:00.000Z',endedAt:'1970-01-01T00:00:10.000Z'}).toString().trim().split('\n').map(JSON.parse);
 const derived=rows.find(r=>r.kind==='agent/events'&&r.data.event?.type==='session/completion');
 assert.ok(derived,'DSH needs an explicitly scoped sum, rather than leaving Judge to infer whether counters are cumulative');
 const summary=derived.data.event.data;assert.deepEqual(summary.usage,{inputTokens:230,outputTokens:18,cacheReadTokens:120,totalTokens:368});
 assert.equal(summary.usageEvidence.records,2);assert.equal(summary.usageEvidence.counterScope,'PER_RESPONSE');assert.equal(summary.usageEvidence.aggregation,'SUM');
 assert.equal(summary.execution.durationMs,1000);assert.equal(summary.execution.scope,'NATIVE_TURN');assert.equal(derived.data.event.seq,undefined);
 assert.deepEqual(rows.filter(r=>r.kind==='session/event').map(r=>r.data.event),events);
 const trace={entries:rows.map((r,i)=>({id:String(i),layer:'AGENT',content:r}))};
 assert.deepEqual(projectTraceOverview(trace).usage,{input:230,output:18,cacheRead:120,reasoning:null});
});

test('DSH does not fabricate counters for missing or invalid native usage',()=>{
 const events=[{type:'session',id:'owned',cwd:'/case'},{type:'assistant/message',seq:1,time:1000,data:{message:{role:'assistant',id:'invalid',content:[]},usage:{inputTokens:'100',outputTokens:-1,totalTokens:null}}},{type:'turn/end',seq:2,time:2000,data:{reason:{kind:'completed'}}}];
 const rows=dshSessionsToProbeJsonl({sessions:[{sessionId:'owned',jsonl:events.map(JSON.stringify).join('\n')}],sourceRunId:'run',pid:1,startedAt:'1970-01-01T00:00:00.000Z',endedAt:'1970-01-01T00:00:10.000Z'}).toString().trim().split('\n').map(JSON.parse);
 assert.ok(!rows.some(r=>r.kind==='agent/events'&&r.data.event?.data?.usage));
});
