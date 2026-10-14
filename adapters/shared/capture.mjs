import {spawn} from 'node:child_process';
import {StringDecoder} from 'node:string_decoder';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {platformEnvironment} from './platform-environment.mjs';
/** Numeric native usage only. Context size, text length and estimates are not consumption. */
export function normalizeUsage(value){
 if(!value||typeof value!=='object'||Array.isArray(value))return null;
 const aliases={inputTokens:['inputTokens','input_tokens','prompt_tokens','input'],outputTokens:['outputTokens','output_tokens','completion_tokens','output'],totalTokens:['totalTokens','total_tokens','total'],cacheReadTokens:['cacheReadTokens','cachedReadTokens','cache_read_tokens','cache_read_input_tokens','prompt_cache_hit_tokens','cacheRead'],cacheWriteTokens:['cacheWriteTokens','cachedWriteTokens','cache_write_tokens','cache_creation_input_tokens','cacheWrite'],reasoningTokens:['reasoningTokens','thoughtTokens','reasoning_tokens','completion_thinking_tokens']};
 const result={};
 for(const [field,keys]of Object.entries(aliases))for(const key of keys){const n=value[key];if(typeof n==='number'&&Number.isFinite(n)&&n>=0){result[field]=n;break;}}
 const details=value.inputTokensDetails??value.input_token_details??value.input_tokens_details??value.prompt_tokens_details;
 if(result.cacheReadTokens===undefined){
  const rows=Array.isArray(details)?details:[details];const values=rows.map(x=>x?.cached_tokens??x?.cache_read).filter(x=>typeof x==='number'&&Number.isFinite(x)&&x>=0);
  if(values.length)result.cacheReadTokens=values.reduce((a,b)=>a+b,0);
 }
 const output=value.output_token_details??value.output_tokens_details??value.completion_tokens_details;
 if(result.reasoningTokens===undefined&&typeof output?.reasoning_tokens==='number'&&Number.isFinite(output.reasoning_tokens)&&output.reasoning_tokens>=0)result.reasoningTokens=output.reasoning_tokens;
 return Object.keys(result).length?result:null;
}

export class UsageLedger {
 constructor(){this.records=new Map();this.omitted=0;}
 record(id,value){const usage=normalizeUsage(value);if(!usage)return;if(typeof id!=='string'||!id){this.omitted++;return;}if(!this.records.has(id)&&this.records.size>=4096){this.omitted++;return;}this.records.set(id,usage);}
 summary(){
  const usage={},fieldCoverage={};
  for(const row of this.records.values())for(const [key,value]of Object.entries(row)){usage[key]=(usage[key]??0)+value;fieldCoverage[key]=(fieldCoverage[key]??0)+1;}
  return {usage:this.records.size?usage:null,records:this.records.size,fieldCoverage,omitted:this.omitted,scope:'OBSERVED_COMPLETED_RESPONSES',counterScope:'PER_RESPONSE',aggregation:'SUM'};
 }
}

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
  constructor(kind){Object.assign(this,{kind,sessionId:kind+'-'+randomUUID(),queue:[],seen:0,noise:0,duplicates:0,mergedUpdates:0,omitted:0,clipped:0,final:'',finalTruncated:false,error:null,cleanup:'NOT_STARTED',result:null});this.tools=new Map();this.events=[];this.unique=new Set();this.total=0;this.usageLedger=new UsageLedger();}
  recordUsage(id,value){this.usageLedger.record(id,value);const {usage,...summary}=this.usageLedger.summary();this.usage=usage;this.usageEvidence={...summary,source:'NATIVE_COMPLETED_RESPONSES'};}
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
    const {tools,events,unique,total,usageLedger,...capture}=this;return capture;
  }
}
export const normalizedEvent=(record,sessionId,seq)=>({at:record.at,kind:'agent/events',data:{sessionId,event:{...record.event,seq}},provenance:record.provenance??{channel:'runtime event stream'}});

function processReader(env,capture,onEvent){
  let buffer='',discard=false,parseErrors=0;
  const decoder=new StringDecoder('utf8');
  const line=value=>{
    if(!value.trim())return;
    try{
      for(const [key,secret] of Object.entries(env))if(/KEY|TOKEN|SECRET|PASSWORD/.test(key)&&secret.length>=8)value=value.split(secret).join('[REDACTED]');
      onEvent(JSON.parse(value),capture);
    }catch{parseErrors++;if(parseErrors>10)capture.error??='AGENT_EVENT_PROTOCOL_ERROR';}
  };
  return {
    write(chunk){
      for(const part of decoder.write(chunk).split(/(?<=\n)/)){
        if(!discard)buffer+=part;
        if(Buffer.byteLength(buffer)>512*1024){buffer='';discard=true;capture.omitted++;}
        if(part.endsWith('\n')){if(!discard)line(buffer);buffer='';discard=false;}
      }
    },
    finish(){if(!discard){buffer+=decoder.end();line(buffer);}return parseErrors;},
  };
}

async function runWindowsProcess({command,args,cwd,env,signal,deadlineMs,capture,onEvent,onSession}){
  // The supervisor receives only OS variables. Target credentials travel over its
  // private stdin, never argv, shell interpolation, a temporary file or diagnostics.
  const system=platformEnvironment(),values=new Map();
  for(const [key,value] of Object.entries({...system,...env})){
    if(typeof value!=='string'||/[=\0]/.test(key)||value.includes('\0'))throw Error('Invalid process environment');
    values.set(key.toUpperCase(),[key,value]);
  }
  const environment=Buffer.from([...values.values()].sort(([a],[b])=>a.toUpperCase().localeCompare(b.toUpperCase())).map(([key,value])=>key+'='+value).join('\0')+'\0\0','utf16le').toString('base64');
  const helper=spawn(path.join(system.SystemRoot??system.WINDIR??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),
    ['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('./windows-process.ps1',import.meta.url))],
    {env:system,windowsHide:true,stdio:['pipe','pipe','pipe']});
  capture.cleanup='PENDING';
  const reader=processReader(env,capture,onEvent);
  const supervisor={phase:'SPAWN',failure:null};
  let protocol='',receipt=null,started=null,exit=null,watchdog,forced=false,finished=false,protocolFailed=false,requestSent=false,stopRequested=false,stderrBytes=0,sessionRecord=Promise.resolve(),resolveOutcome;
  const outcome=new Promise(resolve=>{resolveOutcome=resolve;});
  const stop=reason=>{
    capture.error??=reason;
    if(finished)return;
    stopRequested=true;
    if(requestSent&&!helper.stdin.destroyed&&!helper.stdin.writableEnded)helper.stdin.end('stop\n');
    watchdog??=setTimeout(()=>{
      forced=true;helper.kill(); // Only our supervisor handle; OS closes its job.
      helper.stdout.destroy();helper.stderr.destroy();helper.stdin.destroy();
      resolveOutcome({code:1}); // Missing job receipt always remains UNKNOWN.
    },5000);
  };
  const abort=()=>stop('AGENT_CANCELLED');
  const timer=setTimeout(()=>stop('AGENT_TASK_TIMEOUT'),deadlineMs);
  helper.once('error',()=>{capture.error??='AGENT_PROCESS_START_FAILED';resolveOutcome({code:1});});
  helper.once('close',code=>resolveOutcome({code}));
  helper.stdin.on('error',()=>stop('AGENT_PROCESS_FAILED'));
  helper.stderr.on('data',chunk=>{stderrBytes+=chunk.length;});
  helper.stdout.on('data',chunk=>{
    protocol+=chunk.toString('utf8');
    let end;
    while((end=protocol.indexOf('\n'))>=0){
      const line=protocol.slice(0,end);protocol=protocol.slice(end+1);
      try{
        if(line.length>16384)throw Error('Oversized supervisor frame');
        const row=JSON.parse(line);
        if(row.type==='phase'&&['READ_REQUEST','COMPILE','RUN','CREATE_JOB','CREATE_TARGET','ASSIGNED'].includes(row.name)){
          supervisor.phase=row.name;
          if(row.name==='READ_REQUEST'&&!requestSent){
            requestSent=true;
            helper.stdin.write(JSON.stringify({command,args,cwd:path.resolve(cwd),environment,searchPath:values.get('PATH')?.[1]??''})+'\n');
            if(stopRequested&&!helper.stdin.destroyed&&!helper.stdin.writableEnded)helper.stdin.end('stop\n');
          }
        }
        else if(row.type==='failure'&&['ENTER','CREATE_JOB','CREATE_TARGET','ASSIGNED','POWERSHELL'].includes(row.phase)&&Number.isInteger(row.code))supervisor.failure={phase:row.phase,code:row.code};
        else if(row.type==='stdout'&&typeof row.data==='string')reader.write(Buffer.from(row.data,'base64'));
        else if(row.type==='started'&&!started&&Number.isInteger(row.pid)&&row.pid>0&&Number.isFinite(Date.parse(row.at))){
          started=row;capture.processGroupId=row.pid;
          sessionRecord=Promise.resolve().then(()=>onSession?.(capture.sessionId,{processGroupId:row.pid})).catch(()=>stop('AGENT_SESSION_RECORD_FAILED'));
        }else if(row.type==='exit'&&!exit&&Number.isInteger(row.code)&&Number.isFinite(Date.parse(row.at)))exit=row;
        else if(row.type==='cleanup'&&!receipt&&typeof row.stopped==='boolean'&&Number.isSafeInteger(row.stderrBytes)&&row.stderrBytes>=0)receipt=row;
        else throw Error('Invalid supervisor frame');
      }catch{protocolFailed=true;stop('AGENT_PROCESS_PROTOCOL_ERROR');}
    }
    if(protocol.length>16384){protocol='';protocolFailed=true;stop('AGENT_PROCESS_PROTOCOL_ERROR');}
  });
  signal?.addEventListener('abort',abort,{once:true});
  if(signal?.aborted)abort();
  const result=await outcome;
  finished=true;
  clearTimeout(timer);clearTimeout(watchdog);signal?.removeEventListener('abort',abort);
  await sessionRecord;
  const parseErrors=reader.finish();
  if(started&&exit)capture.execution={startedAt:started.at,endedAt:exit.at,durationMs:Date.parse(exit.at)-Date.parse(started.at),scope:'AGENT_PROCESS'};
  if(result.code!==0||receipt?.failed||!receipt||!exit)capture.error??=started?'AGENT_PROCESS_FAILED':'AGENT_PROCESS_START_FAILED';
  else if(exit.code!==0)capture.error??='AGENT_PROCESS_FAILED';
  if(!capture.result&&!capture.error)capture.error='AGENT_TURN_INCOMPLETE';
  capture.cleanup=!forced&&!protocolFailed&&!protocol.trim()&&receipt?.stopped===true?'STOPPED':'UNKNOWN';
  capture.diagnostics={exitCode:exit?.code??null,stderrBytes:stderrBytes+(receipt?.stderrBytes??0),parseErrors,supervisor:{...supervisor,forced}};
  return capture.finish();
}

/** Read stdout push events once. Bound each line and drain excess without buffering it. */
export async function runProcess({command,args,cwd,env,signal,deadlineMs,capture,onEvent,onSession}) {
  if(signal?.aborted){capture.error='AGENT_CANCELLED';capture.cleanup='STOPPED';return capture.finish();}
  if(process.platform==='win32')return runWindowsProcess({command,args,cwd,env,signal,deadlineMs,capture,onEvent,onSession});
  const child=spawn(command,args,{cwd,env,detached:true,stdio:['ignore','pipe','pipe']});
  const processStartedAt=new Date().toISOString();
  capture.processGroupId=child.pid;
  capture.cleanup='PENDING';
  let timer,killTimer,closed=false,stderrBytes=0,sessionRecord=Promise.resolve();
  const reader=processReader(env,capture,onEvent);
  const terminate=reason=>{
    capture.error??=reason;
    try{if(child.pid)process.kill(-child.pid,'SIGTERM');}catch(error){if(error.code!=='ESRCH')capture.cleanup='UNKNOWN';}
    killTimer??=setTimeout(()=>{try{if(child.pid)process.kill(-child.pid,'SIGKILL');}catch{}},2000);
    killTimer.unref();
  };
  const abort=()=>terminate('AGENT_CANCELLED');
  signal?.addEventListener('abort',abort,{once:true});
  timer=setTimeout(()=>terminate('AGENT_TASK_TIMEOUT'),deadlineMs);
  child.stdout.on('data',chunk=>reader.write(chunk));
  // Never persist raw stderr: provider failures may include credentials or task content.
  child.stderr.on('data',chunk=>{stderrBytes+=chunk.length;});
  const outcome=await new Promise(resolve=>{
    child.once('error',()=>{capture.error='AGENT_PROCESS_START_FAILED';resolve({code:1});});
    child.once('close',(code,exitSignal)=>{closed=true;const endedAt=new Date().toISOString();capture.execution={startedAt:processStartedAt,endedAt,durationMs:Date.parse(endedAt)-Date.parse(processStartedAt),scope:'AGENT_PROCESS'};resolve({code,exitSignal});});
    sessionRecord=Promise.resolve(onSession?.(capture.sessionId,{processGroupId:child.pid})).catch(()=>terminate('AGENT_SESSION_RECORD_FAILED'));
  });
  await sessionRecord;
  const parseErrors=reader.finish();
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
