import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {zstdCompressSync} from 'node:zlib';
import path from 'node:path';
import {temporary} from './support.mjs';
import {collectTranscript} from '../../adapters/openclaw/transcript.mjs';
for(const layout of ['json','json+zstd','zstd'])test('OpenClaw transcript layout '+layout+' preserves native tool IDs and session isolation',async t=>{
 const file=path.join(await temporary(t),'events.sqlite'),db=new DatabaseSync(file);
 const json=layout.includes('json'),compressed=layout.includes('zstd');
 db.exec(`CREATE TABLE transcript_events(session_id TEXT,seq INTEGER${json?',event_json TEXT':''}${compressed?',event_zstd BLOB':''})`);
 const insert=db.prepare(`INSERT INTO transcript_events VALUES(${Array(2+Number(json)+Number(compressed)).fill('?').join(',')})`);
 const put=(sessionId,seq,message)=>{const value=JSON.stringify({type:'message',timestamp:'2026-10-10T00:00:00Z',message});insert.run(sessionId,seq,...json?[compressed?null:value]:[],...compressed?[zstdCompressSync(Buffer.from(value))]:[]);};
 put('mine',1,{role:'assistant',content:[{type:'toolCall',id:'actual-id',name:'read',arguments:{path:'input/a.txt'}}]});
 put('mine',2,{role:'toolResult',toolCallId:'actual-id',toolName:'read',content:[{type:'text',text:'observed result'}]});
 put('mine',3,{role:'assistant',stopReason:'stop',content:[{type:'text',text:'done'}]});
 put('other',1,{role:'assistant',stopReason:'stop',content:[{type:'text',text:'OTHER SESSION'}]});db.close();
 const result=collectTranscript(file,'mine');assert.equal(result.final,'done');assert.equal(result.omitted,0);
 assert.deepEqual(result.queue.filter(r=>r.event.type.startsWith('tool/')).map(r=>r.event.data.callId),['actual-id','actual-id']);
 assert.ok(!JSON.stringify(result).includes('OTHER SESSION'));assert.throws(()=>collectTranscript(file),/SESSION_MISMATCH/);
});
test('unknown OpenClaw transcript storage is rejected explicitly',async t=>{
 const file=path.join(await temporary(t),'events.sqlite'),db=new DatabaseSync(file);
 db.exec('CREATE TABLE transcript_events(session_id TEXT,seq INTEGER,new_payload BLOB)');db.close();
 assert.throws(()=>collectTranscript(file,'mine'),/OPENCLAW_TRANSCRIPT_SCHEMA_UNSUPPORTED/);
});
