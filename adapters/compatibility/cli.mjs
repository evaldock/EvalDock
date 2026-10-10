import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createAdapter} from '../shared/factory.mjs';
import {createWorkBuddyAdapter} from '../workbuddy/adapter.mjs';
import {loadTargets} from '../shared/registry.mjs';
import {ensureCompatibility} from './check.mjs';
import {acquire} from './store.mjs';
import {readJSON} from './store.mjs';
import {PROTOCOLS,capabilities,classify} from './contracts.mjs';
const args=process.argv.slice(2),value=flag=>args[args.indexOf(flag)+1];
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
if(args.includes('--list')){
  const targets=await loadTargets(root);
  console.log(JSON.stringify({targets:[...targets,{id:'workbuddy',kind:'workbuddy'}].map(t=>({targetId:t.id,kind:t.kind,protocol:PROTOCOLS[t.kind],required:capabilities({kind:t.kind,configuration:t})})),dsh:{targetId:'dsh',descriptor:'config/targets/real-dsh.json',web:'dsh.web-session/v1',headless:PROTOCOLS['dsh-headless']}},null,2));
}else{
  const controller=new AbortController();process.once('SIGINT',()=>controller.abort());process.once('SIGTERM',()=>controller.abort());
  let release;
  try{
    if(!args.includes('--target-id')||!value('--target-id')||args.some(x=>x.startsWith('--')&&!['--target-id','--force','--descriptor'].includes(x)))throw Error('AGENT_COMPATIBILITY_ARGUMENTS_INVALID');
    const id=value('--target-id');
    if(id.startsWith('--')||args.includes('--descriptor')&&(id!=='dsh'||!value('--descriptor')||value('--descriptor').startsWith('--')))throw Error('AGENT_COMPATIBILITY_ARGUMENTS_INVALID');
    let adapter;
    if(id==='dsh'){const descriptor=await readJSON(args.includes('--descriptor')?path.resolve(value('--descriptor')):path.join(root,'config/targets/real-dsh.json'));if(!descriptor)throw Error('AGENT_DSH_CONFIGURATION_UNAVAILABLE');const {createDshCompatibilityAdapter}=await import('./dsh.mjs');adapter=createDshCompatibilityAdapter(descriptor);}
    else adapter=id==='workbuddy'?createWorkBuddyAdapter():await createAdapter(root,id);
    release=await acquire(adapter);
    const report=await ensureCompatibility({root,adapter,signal:controller.signal,force:args.includes('--force'),onProgress:console.error});
    console.log(JSON.stringify(report,null,2));process.exitCode=report.status==='COMPATIBLE'?0:1;
  }catch(e){const code=/^[A-Z][A-Z0-9_]+$/.test(e.message)?e.message:'AGENT_COMPATIBILITY_CHECK_FAILED';console.log(JSON.stringify({schema:'evaldock.compatibility/v1',status:classify(code),issues:[{code}]}));process.exitCode=1;}
  finally{await release?.();}
}
