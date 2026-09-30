import {DatabaseSync} from 'node:sqlite';
import {zstdDecompressSync} from 'node:zlib';
import path from 'node:path';
import {Capture} from '../shared/capture.mjs';
export function collectTranscript(database,sessionId){
 const db=new DatabaseSync(database,{readOnly:true}),capture=new Capture('openclaw');
 try{
  const ids=db.prepare('SELECT DISTINCT session_id FROM transcript_events LIMIT 2').all().map(r=>r.session_id);
  sessionId??=ids.length===1?ids[0]:undefined;
  if(!sessionId||!db.prepare('SELECT 1 FROM transcript_events WHERE session_id=? LIMIT 1').get(sessionId))throw Error('OPENCLAW_TRANSCRIPT_SESSION_MISMATCH');
  const count=db.prepare('SELECT COUNT(*) AS n FROM transcript_events WHERE session_id=?').get(sessionId).n;
  const retainedRows=Math.min(count,256);
  const rows=db.prepare('SELECT * FROM (SELECT seq,substr(event_json,1,524288) AS body,length(event_json) AS size,substr(event_zstd,1,524288) AS compressed,length(event_zstd) AS compressedSize FROM transcript_events WHERE session_id=? ORDER BY seq DESC LIMIT 256) ORDER BY seq ASC').iterate(sessionId);
  capture.omitted+=Math.max(0,count-retainedRows);
  for(const row of rows){
   if(row.size>524288||row.compressedSize>524288){capture.omitted++;continue;}
   let event;try{event=JSON.parse(row.body??zstdDecompressSync(row.compressed,{maxOutputLength:524288}).toString('utf8'));}catch{capture.omitted++;continue;}
   if(event.type!=='message')continue;const m=event.message,at=event.timestamp??new Date(m.timestamp).toISOString();
   if(m.role==='assistant'){
    for(const c of m.content??[])if(c.type==='toolCall')capture.add('tool/call',{callId:c.id,name:c.name,arguments:c.arguments},at);
    if(m.stopReason==='stop')capture.finalText((m.content??[]).filter(c=>c.type==='text').map(c=>c.text).join(''));
   }else if(m.role==='toolResult')capture.add('tool/result',{callId:m.toolCallId,name:m.toolName,result:m.content?.filter(c=>c.type==='text').map(c=>c.text).join(''),isError:m.isError},at);
  }
  capture.nativeSessionId=sessionId;
  capture.add('probe/completed',{mode:'COMPLETION_TRIGGERED_TRANSCRIPT',nativeSessionId:sessionId,totalRows:count,retainedRows,omitted:capture.omitted});
  return capture.finish();
 }finally{db.close();}
}
if(process.argv[1]===new URL(import.meta.url).pathname){
 try{const r=collectTranscript(path.join(process.argv[2],'agents/main/agent/openclaw-agent.sqlite'),process.argv[3]||undefined);process.stdout.write(JSON.stringify(r));}
 catch(e){process.stdout.write(JSON.stringify({error:e.message?.startsWith('OPENCLAW_')?e.message:'OPENCLAW_TRANSCRIPT_UNAVAILABLE'}));process.exitCode=1;}
}
