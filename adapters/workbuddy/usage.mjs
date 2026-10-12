import path from 'node:path';
import {homedir} from 'node:os';
import {readEvidenceFile} from '../../dist/src/all-trace/store.js';
import {UsageLedger} from '../shared/capture.mjs';

/** One read after completion, confined to the newly owned Session and workspace. No text is returned. */
export async function readWorkBuddyUsage({cwd,sessionId,historyRoot=path.join(homedir(),'.workbuddy','projects')}){
 const unavailable=reason=>({usage:null,records:0,source:'OWNED_NATIVE_SESSION_ARCHIVE',reason});
 if(!path.isAbsolute(cwd??'')||typeof sessionId!=='string'||!/^[a-zA-Z0-9._-]{1,200}$/.test(sessionId)||['.','..'].includes(sessionId))return unavailable('NATIVE_USAGE_SESSION_INVALID');
 const project=cwd.replace(/^\//,'').replaceAll('/','-'),ledger=new UsageLedger();let omitted=0;
 try{
  const bytes=await readEvidenceFile(path.resolve(historyRoot),project+'/'+sessionId+'.jsonl',16*1024*1024);
  for(const line of bytes.toString('utf8').split('\n')){
   if(!line.trim())continue;if(Buffer.byteLength(line)>512*1024){omitted++;continue;}
   let row;try{row=JSON.parse(line);}catch{omitted++;continue;}
   if(row.sessionId!==sessionId||row.cwd!==cwd||!['message','function_call'].includes(row.type))continue;
   const p=row.providerData;
   ledger.record(p?.messageId??row.id,p?.usage??p?.rawUsage);
  }
  const summary=ledger.summary();
  return {...summary,source:'OWNED_NATIVE_SESSION_ARCHIVE',inputTokenBasis:'INCLUDES_CACHE',omitted:summary.omitted+omitted,...summary.usage?{}:{reason:'NATIVE_USAGE_NOT_EXPOSED'}};
 }catch{return unavailable('NATIVE_USAGE_ARCHIVE_UNAVAILABLE');}
}
