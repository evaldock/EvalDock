import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,writeFile,symlink,chmod} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {temporary} from './support.mjs';
import {Capture,runProcess} from '../../adapters/shared/capture.mjs';
import {piEvent} from '../../adapters/pi/adapter.mjs';
import {createHermesAdapter} from '../../adapters/hermes/adapter.mjs';
import {normalizeUsage} from '../../adapters/shared/capture.mjs';
import {buildTrace} from '../../adapters/shared/evidence.mjs';
import {normalizedEvent} from '../../adapters/shared/capture.mjs';
import {projectTraceOverview} from '../../dist/src/reporting/trace-overview.js';

test('Pi preserves each completed response usage once, including tool turns and cache',()=>{
 const c=new Capture('pi');
 const message={id:'response-1',role:'assistant',content:[],usage:{input:100,output:8,cacheRead:60,totalTokens:108}};
 piEvent({type:'message_end',message},c);piEvent({type:'message_end',message},c);
 piEvent({type:'message_end',message:{...message,id:'response-2',usage:{input:110,output:4,totalTokens:114}}},c);
 piEvent({type:'agent_end'},c);
 assert.equal(c.result.usage.inputTokens,210);assert.equal(c.result.usage.outputTokens,12);
 assert.equal(c.result.usage.cacheReadTokens,60);assert.equal(c.result.usage.totalTokens,222);
});

test('WorkBuddy reads only the owned native archive, deduplicates usage mirrors and rejects symlinks',async t=>{
 const {readWorkBuddyUsage}=await import('../../adapters/workbuddy/usage.mjs');
 const root=await temporary(t),cwd=path.join(root,'workspace with spaces'),historyRoot=path.join(root,'projects');
 const dir=path.join(historyRoot,cwd.replace(/^\//,'').replaceAll('/','-'));await mkdir(dir,{recursive:true});
 const row={type:'function_call',id:'call-1',sessionId:'owned',cwd,providerData:{messageId:'response-1',usage:{inputTokens:100,outputTokens:5,totalTokens:105,inputTokensDetails:[{cached_tokens:80}]}},content:'private text must not be copied'};
 const other={...row,id:'foreign',sessionId:'other',providerData:{messageId:'other',usage:{inputTokens:9999}}};
 await writeFile(path.join(dir,'owned.jsonl'),[row,{...row,id:'mirror'},other].map(JSON.stringify).join('\n'));
 const r=await readWorkBuddyUsage({cwd,sessionId:'owned',historyRoot});
 assert.equal(r.usage.inputTokens,100);assert.equal(r.usage.cacheReadTokens,80);assert.equal(r.records,1);
 assert.ok(!JSON.stringify(r).includes('private text'));assert.ok(!JSON.stringify(r).includes('9999'));
 await symlink(path.join(dir,'owned.jsonl'),path.join(dir,'linked.jsonl'));
 assert.equal((await readWorkBuddyUsage({cwd,sessionId:'linked',historyRoot})).usage,null);
 assert.equal((await readWorkBuddyUsage({cwd,sessionId:'../owned',historyRoot})).usage,null);
});

test('LangGraph captures native message usage without repeated checkpoint snapshots',()=>{
 const script=`import sys,json\nsys.path.insert(0,'adapters/langgraph')\nimport runner\nrows=[]\nrunner.emit=lambda kind,data:rows.append((kind,data))\ne=runner.Evidence()\nm={'type':'ai','id':'response-1','content':'done','usage_metadata':{'input_tokens':100,'output_tokens':9,'total_tokens':109,'input_token_details':{'cache_read':60}}}\ne.message(m)\ne.message(m)\nprint(json.dumps([data for kind,data in rows if kind=='session/usage']))`;
 const r=spawnSync('python3',['-c',script],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);
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
 assert.equal(spawnSync('python3',['-c',seed,db],{encoding:'utf8'}).status,0);
 const r=spawnSync('python3',['adapters/hermes/session-evidence.py',db,'--session-archive'],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);
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
 await symlink('/usr/bin/python3',path.join(root,'python'));
 await writeFile(cli,`#!/usr/bin/python3\nimport os,json,sqlite3\nfrom pathlib import Path\nc=sqlite3.connect(str(Path(os.environ['HERMES_HOME'])/'state.db'))\nc.execute('CREATE TABLE sessions(id TEXT,input_tokens INTEGER,output_tokens INTEGER,cache_read_tokens INTEGER,cache_write_tokens INTEGER,reasoning_tokens INTEGER)')\nc.execute('INSERT INTO sessions VALUES(?,?,?,?,?,?)',('owned',100,5,80,0,2))\nc.commit();c.close()\nprint(json.dumps({'type':'system','session_id':'owned'}))\nprint(json.dumps({'type':'result','session_id':'owned','exit_code':0,'text':'done','tokens':{'input':100,'output':5,'total':185}}))\n`);await chmod(cli,0o700);
 const adapter=createHermesAdapter({executable:cli,model:'synthetic'});
 const r=await adapter.run({context:{env:process.env,protocol:{id:'hermes.stream-json/v1',flags:['--format']}},caseDirectory,cwd:root,prompt:'synthetic',deadlineMs:5000});
 const u=normalizeUsage(r.result.usage);assert.equal(u.cacheReadTokens,80);assert.equal(u.reasoningTokens,2);
 assert.equal(u.totalTokens,185);assert.equal(r.usageEvidence.inputTokenBasis,'EXCLUDES_CACHE');assert.equal(r.error,null);
});
