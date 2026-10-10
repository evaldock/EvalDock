import {execFileSync} from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {writeFile,mkdir,copyFile} from 'node:fs/promises';
import {temporary} from './support.mjs';
import {Capture,runProcess} from '../../adapters/shared/capture.mjs';
import {hermesEvent} from '../../adapters/hermes/adapter.mjs';
import {openClawEvent} from '../../adapters/openclaw/adapter.mjs';
import {loadTargets} from '../../adapters/shared/registry.mjs';
import {createAdapter} from '../../adapters/shared/run.mjs';
test('Hermes push events preserve parallel call IDs, discard text deltas, retain final and failure',()=>{
 const c=new Capture('hermes');for(let i=0;i<10000;i++)hermesEvent({type:'text',text:'token'},c);
 for(const id of ['a','b'])hermesEvent({type:'tool_use',name:'terminal',tool_call_id:id,input:{command:id}},c);
 for(const id of ['b','a'])hermesEvent({type:'tool_result',name:'terminal',tool_call_id:id,output:id},c);
 hermesEvent({type:'result',exit_code:0,text:'answer',tokens:{total:15}},c);const r=c.finish();
 assert.equal(r.queue.length,4);assert.equal(r.noise,10000);assert.equal(r.final,'answer');assert.equal(r.result.usage.total,15);
 assert.equal(r.queue.find(r=>r.event.type==='tool/result'&&r.event.data.callId==='b').event.data.result,'b');
 const failed=new Capture('hermes');hermesEvent({type:'result',exit_code:1,text:'partial',error:'Iteration budget'},failed);assert.equal(failed.error,'HERMES_EXECUTION_FAILED');
});
test('OpenClaw distinguishes runtime failure and keeps tool traffic bounded',()=>{
 const c=new Capture('openclaw');for(let i=0;i<1000;i++){openClawEvent({type:'tool/call',data:{callId:String(i),name:'read',arguments:{path:'file'}}},c);openClawEvent({type:'tool/result',data:{callId:String(i),name:'read',result:'x'.repeat(24000)}},c);}
 openClawEvent({type:'runtime/result',data:{ok:true,status:'ok',final:'done',probeReady:true}},c);
 const r=c.finish();assert.ok(r.omitted>0);assert.ok(Buffer.byteLength(JSON.stringify(r))<300*1024);assert.equal(r.final,'done');assert.equal(r.error,null);
 const failed=new Capture('openclaw');openClawEvent({type:'runtime/result',data:{ok:false,status:'error',error:{message:'provider failed'},probeReady:true}},failed);assert.equal(failed.error,'OPENCLAW_EXECUTION_FAILED');
});
test('OpenClaw runner frames a single JSON envelope and masks credentials',async t=>{
 const root=await temporary(t),cli=path.join(root,'fake-cli.mjs');
 await writeFile(cli,`console.log(JSON.stringify({ok:true,status:'ok',final:'secret-api-value',sessionId:'native'},null,2));`);
 const r=await runProcess({command:process.execPath,args:[new URL('../../adapters/openclaw/runner.mjs',import.meta.url).pathname,process.execPath,cli],cwd:root,env:{PATH:process.env.PATH,DEEPSEEK_API_KEY:'secret-api-value'},deadlineMs:10000,capture:new Capture('openclaw'),onEvent:openClawEvent});
 assert.equal(r.error,null,JSON.stringify(r));assert.equal(r.final,'[REDACTED]');assert.equal(r.cleanup,'STOPPED');assert.ok(!JSON.stringify(r).includes('secret-api-value'));assert.equal(r.diagnostics.parseErrors,0);
});
test('both new targets use the shared registry and implement the same adapter contract',async t=>{
 const root=await temporary(t);await mkdir(path.join(root,'config'));await writeFile(path.join(root,'config/agents.json'),JSON.stringify({schema:'evaldock.agent-targets/v1',targets:['hermes','openclaw'].map(kind=>({id:kind,kind,name:kind,sourceRoot:root,node:process.execPath,executable:process.execPath}))}));
 const targets=await loadTargets(root);for(const kind of ['hermes','openclaw']){
  assert.equal(targets.filter(t=>t.kind===kind).length,1);const a=await createAdapter(root,kind);assert.equal(a.kind,kind);for(const method of ['inspect','prepare','run','dispose','staticInfo'])assert.equal(typeof a[method],'function');assert.equal(a.trace.normalizeEvent instanceof Function,true);
 }
});

test('completion transcript reader isolates native session, pairs actual IDs and bounds compressed/large data',async t=>{
 const root=await temporary(t),script=path.join(root,'reader-test.mjs');
 const uri=new URL('../../adapters/openclaw/transcript.mjs',import.meta.url).href;
 await writeFile(script,`import {DatabaseSync} from 'node:sqlite';import {zstdCompressSync} from 'node:zlib';import {collectTranscript} from ${JSON.stringify(uri)};
 const file=process.argv[2],db=new DatabaseSync(file);db.exec('CREATE TABLE transcript_events(session_id TEXT,seq INTEGER,event_json TEXT,event_zstd BLOB)');const put=db.prepare('INSERT INTO transcript_events VALUES(?,?,?,?)');
 const event=(message)=>JSON.stringify({type:'message',timestamp:'2026-09-24T08:00:00Z',message});
 put.run('mine',0,event({role:'assistant',content:[{type:'toolCall',id:'a',name:'read',arguments:{path:'input'}}]}),null);
 put.run('mine',1,null,zstdCompressSync(Buffer.from(event({role:'toolResult',toolCallId:'a',toolName:'read',content:[{type:'text',text:'answer'}]}))));
 put.run('mine',2,event({role:'assistant',stopReason:'stop',content:[{type:'text',text:'done'}]}),null);
 put.run('other',0,event({role:'assistant',stopReason:'stop',content:[{type:'text',text:'PRIVATE OTHER SESSION'}]}),null);
 for(let n=3;n<303;n++)put.run('large',n,event({role:'toolResult',toolCallId:'t'+n,toolName:'read',content:[{type:'text',text:'x'.repeat(20000)}]}),null);
 db.close();console.log(JSON.stringify({mine:collectTranscript(file,'mine'),large:collectTranscript(file,'large')}));`);
 const out=execFileSync(process.execPath,[script,path.join(root,'transcript.sqlite')],{maxBuffer:512*1024,stdio:['ignore','pipe','pipe']});const r=JSON.parse(out);
 assert.equal(r.mine.final,'done');assert.ok(!JSON.stringify(r.mine).includes('PRIVATE OTHER SESSION'));assert.deepEqual(r.mine.queue.filter(e=>e.event.type.startsWith('tool/')).map(e=>e.event.data.callId),['a','a']);assert.ok(r.large.omitted>0);assert.ok(Buffer.byteLength(JSON.stringify(r.large))<300*1024);
});

test('OpenClaw transcript CLI runs from a desktop workspace path containing spaces',async t=>{
 const root=path.join(await temporary(t),'Application Support/EvalDock'),reader=path.join(root,'adapters/openclaw/transcript.mjs');
 await mkdir(path.dirname(reader),{recursive:true});await mkdir(path.join(root,'adapters/shared'),{recursive:true});
 await copyFile(new URL('../../adapters/openclaw/transcript.mjs',import.meta.url),reader);
 await copyFile(new URL('../../adapters/shared/capture.mjs',import.meta.url),path.join(root,'adapters/shared/capture.mjs'));
 const state=path.join(root,'state'),db=path.join(state,'agents/main/agent/openclaw-agent.sqlite');await mkdir(path.dirname(db),{recursive:true});
 execFileSync(process.execPath,['--input-type=module','-e',`import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(process.argv[1]);db.exec('CREATE TABLE transcript_events(session_id TEXT,seq INTEGER,event_json TEXT,event_zstd BLOB)');db.prepare('INSERT INTO transcript_events VALUES(?,?,?,?)').run('mine',1,JSON.stringify({type:'message',timestamp:'2026-10-10T00:00:00Z',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'done'}]}}),null);db.close();`,db],{stdio:['ignore','pipe','pipe']});
 const out=execFileSync(process.execPath,[reader,state,'mine'],{stdio:['ignore','pipe','pipe']}).toString();assert.ok(out,'CLI must emit transcript JSON from a path with spaces');assert.equal(JSON.parse(out).final,'done');
});
