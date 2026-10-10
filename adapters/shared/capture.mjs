import {spawn} from 'node:child_process';
import {StringDecoder} from 'node:string_decoder';
import {createHash,randomUUID} from 'node:crypto';

const bytes=x=>Buffer.byteLength(JSON.stringify(x));
const digest=x=>createHash('sha256').update(x).digest('hex');
export function excerpt(value,limit=16384) {
  return bounded(redact(value),limit);
}
function redact(value) {
  if(value===null||typeof value!=='object')return value;
  if(Array.isArray(value))return value.map(redact);
  return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,/^(api[_-]?key|authorization|access[_-]?token|password|secret)$/i.test(k)?'[REDACTED]':redact(v)]));
}
function bounded(value,limit) {
  if(typeof value==='string'&&Buffer.byteLength(value)>limit){
    const b=Buffer.from(value);
    return {representation:'EXCERPT',prefix:b.subarray(0,limit/2).toString('utf8'),suffix:b.subarray(-limit/2).toString('utf8'),originalBytes:b.length,sha256:digest(b),omitted:true};
  }
  if(value===null||typeof value!=='object')return value;
  const json=JSON.stringify(value);
  if(Buffer.byteLength(json)>32768)return bounded(json,limit);
  if(Array.isArray(value))return value.map(x=>bounded(x,limit));
  return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,bounded(v,limit)]));
}
export class Capture {
  constructor(kind){Object.assign(this,{kind,sessionId:kind+'-'+randomUUID(),queue:[],seen:0,noise:0,duplicates:0,mergedUpdates:0,omitted:0,clipped:0,final:'',finalTruncated:false,error:null,cleanup:'NOT_STARTED',result:null});this.tools=new Map();this.events=[];this.unique=new Set();this.total=0;}
  finalText(text){
    if(typeof text!=='string')return;
    const body=Buffer.from(text);this.finalTruncated=body.length>65536;
    this.final=this.finalTruncated?body.subarray(0,65536).toString('utf8'):text;
  }
  add(type,data={},at=new Date().toISOString()) {
    this.seen++;
    if(['token','thinking','heartbeat','state/snapshot'].includes(type)){this.noise++;return;}
    const limited=JSON.parse(JSON.stringify(excerpt(data)));if(JSON.stringify(limited)!==JSON.stringify(data))this.clipped++;
    const event={type,data:limited},record={at,event},size=bytes(record);
    if(type==='tool/call'||type==='tool/result'){
      const callId=data.callId;if(!callId){this.omitted++;return;}
      const key=String(callId),old=this.tools.get(key)??{};
      const phase=type==='tool/call'?'call':'result';
      if(old[phase]){this.total-=bytes(old[phase]);this.mergedUpdates++;}
      old[phase]=record;this.total+=size;this.tools.set(key,old);
    }else{
      const key=type+':'+digest(JSON.stringify(limited));
      if(this.unique.has(key)){this.duplicates++;return;}
      this.unique.add(key);this.events.push(record);this.total+=size;
      if(this.events.length>64){const old=this.events.shift();this.total-=bytes(old);this.unique.delete(old.event.type+':'+digest(JSON.stringify(old.event.data)));this.omitted++;}
    }
    while(this.total>192*1024||this.tools.size>128){
      if(this.tools.size){
        const key=this.tools.keys().next().value,old=this.tools.get(key);
        for(const value of Object.values(old)){this.total-=bytes(value);this.omitted++;}
        this.tools.delete(key);
      }else{const old=this.events.shift();if(!old)break;this.total-=bytes(old);this.unique.delete(old.event.type+':'+digest(JSON.stringify(old.event.data)));this.omitted++;}
    }
  }
  finish(){
    this.queue=[...this.events,...[...this.tools.values()].flatMap(t=>[t.call,t.result].filter(Boolean))].sort((a,b)=>a.at.localeCompare(b.at));
    const {tools,events,unique,total,...capture}=this;return capture;
  }
}
export const normalizedEvent=(record,sessionId,seq)=>({at:record.at,kind:'agent/events',data:{sessionId,event:{...record.event,seq}},provenance:record.provenance??{channel:'runtime event stream'}});

/** Read stdout push events once. Bound each line and drain excess without buffering it. */
export async function runProcess({command,args,cwd,env,signal,deadlineMs,capture,onEvent,onSession}) {
  if(signal?.aborted){capture.error='AGENT_CANCELLED';capture.cleanup='STOPPED';return capture.finish();}
  const child=spawn(command,args,{cwd,env,detached:true,stdio:['ignore','pipe','pipe']});
  capture.processGroupId=child.pid;
  capture.cleanup='PENDING';
  let timer,killTimer,buffer='',discard=false,closed=false,stderrBytes=0,parseErrors=0,sessionRecord=Promise.resolve();
  const decoder=new StringDecoder('utf8');
  const terminate=reason=>{
    capture.error??=reason;
    try{if(child.pid)process.kill(-child.pid,'SIGTERM');}catch(error){if(error.code!=='ESRCH')capture.cleanup='UNKNOWN';}
    killTimer??=setTimeout(()=>{try{if(child.pid)process.kill(-child.pid,'SIGKILL');}catch{}},2000);
    killTimer.unref();
  };
  const abort=()=>terminate('AGENT_CANCELLED');
  signal?.addEventListener('abort',abort,{once:true});
  timer=setTimeout(()=>terminate('AGENT_TASK_TIMEOUT'),deadlineMs);
  const line=value=>{
    if(!value.trim())return;
    try{
      for(const [key,secret] of Object.entries(env))if(/KEY|TOKEN|SECRET|PASSWORD/.test(key)&&secret.length>=8)value=value.split(secret).join('[REDACTED]');
      onEvent(JSON.parse(value),capture);
    }
    catch{parseErrors++;if(parseErrors>10)capture.error??='AGENT_EVENT_PROTOCOL_ERROR';}
  };
  child.stdout.on('data',chunk=>{
    const text=decoder.write(chunk);
    for(const part of text.split(/(?<=\n)/)){
      if(!discard)buffer+=part;
      if(Buffer.byteLength(buffer)>512*1024){buffer='';discard=true;capture.omitted++;}
      if(part.endsWith('\n')){if(!discard)line(buffer);buffer='';discard=false;}
    }
  });
  // Never persist raw stderr: provider failures may include credentials or task content.
  child.stderr.on('data',chunk=>{stderrBytes+=chunk.length;});
  const outcome=await new Promise(resolve=>{
    child.once('error',()=>{capture.error='AGENT_PROCESS_START_FAILED';resolve({code:1});});
    child.once('close',(code,exitSignal)=>{closed=true;resolve({code,exitSignal});});
    sessionRecord=Promise.resolve(onSession?.(capture.sessionId,{processGroupId:child.pid})).catch(()=>terminate('AGENT_SESSION_RECORD_FAILED'));
  });
  await sessionRecord;
  if(!discard){buffer+=decoder.end();line(buffer);}
  clearTimeout(timer);clearTimeout(killTimer);signal?.removeEventListener('abort',abort);
  // A tool may leave descendants after the Agent exits. Clean only our detached group.
  const groupAlive=()=>{if(!child.pid)return false;try{process.kill(-child.pid,0);return true;}catch(e){return e.code!=='ESRCH';}};
  if(groupAlive()){
    try{process.kill(-child.pid,'SIGTERM');}catch{}
    for(let i=0;i<20&&groupAlive();i++)await new Promise(resolve=>setTimeout(resolve,100));
    if(groupAlive()){
      try{process.kill(-child.pid,'SIGKILL');}catch{}
      for(let i=0;i<10&&groupAlive();i++)await new Promise(resolve=>setTimeout(resolve,100));
    }
  }
  if(outcome.code!==0)capture.error??='AGENT_PROCESS_FAILED';
  if(!capture.result&&!capture.error)capture.error='AGENT_TURN_INCOMPLETE';
  capture.cleanup=(closed||!child.pid)&&!groupAlive()?'STOPPED':'UNKNOWN';
  capture.diagnostics={exitCode:outcome.code,stderrBytes,parseErrors};
  return capture.finish();
}
