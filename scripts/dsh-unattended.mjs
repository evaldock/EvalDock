/** VM-local companion for this installed DSH; keeps ordinary and Eval sessions unattended. */
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {rpc,liveIdentity} from '../dist/src/runtime/web-target.js';
import {pollInterval,trimLogs} from '../workbench/lib/background-io.mjs';
import {startAutoInteraction} from '../dist/src/runtime/auto-interaction.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const descriptor=JSON.parse(await readFile(path.join(root,'config/targets/real-dsh.json'),'utf8'));
const base=descriptor.webEndpoint;
let syncing=false,lastError="",running=false,closed=false;
function reportError(error){
  const message=error?.code===1&&String(error?.cmd).includes("lsof")?"DSH_STOPPED_WAITING":error instanceof Error?error.message:String(error);
  if(message===lastError)return;lastError=message;
  console.error(new Date().toISOString(),message);
}
async function permissions(){
  if(syncing)return;syncing=true;
  try{
    await liveIdentity(descriptor);
    const settings=await rpc(base,'settings.describe',{});
    const ns=settings.namespaces.find(n=>n.ns==='permission'||n.ns==='permissionPresets');
    if(!ns)throw Error('DSH permission settings unavailable');
    if(ns.value.defaultPreset!=='danger-full-access')
      await rpc(base,'settings.update',{ns:ns.ns,patch:{defaultPreset:'danger-full-access'},expectedRevision:ns.revision});
    const sessions=await rpc(base,'session.list',{});
    running=sessions.items.some(s=>s.running);
    for(const s of sessions.items.filter(s=>s.running && s.projections?.values?.permissions?.currentValue!=='danger-full-access')){
      const r=await rpc(base,'session.prompt',{sessionId:s.sessionId,mode:'steer',content:[{type:'text',text:'/permission danger-full-access'}]});
      if(r.command?.kind!=='success')throw Error('DSH permission command was not applied');
      console.log(JSON.stringify({at:new Date().toISOString(),type:'permission',sessionId:s.sessionId,preset:'danger-full-access'}));
    }
  }finally{syncing=false;}
}
const interaction=startAutoInteraction({
  base,beforeConnect:async()=>{await liveIdentity(descriptor);await permissions();},
  onDecision:record=>console.log(JSON.stringify(record)),
  onError:reportError
});
const logFiles=[
  ...['unattended.log','unattended.error.log'].map(n=>path.join(root,'var/logs/dsh-control',n)),
  ...['service.log','plugin-install.log'].map(n=>path.join(descriptor.dshHome,'evaldock-control',descriptor.profile,n))
];
let timer;
async function tick(){
  try{await permissions();}catch(e){reportError(e);}
  try{await trimLogs(logFiles);}catch(e){reportError(e);}
  if(!closed)timer=setTimeout(tick,pollInterval(running));
}
timer=setTimeout(tick,pollInterval(false));
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{closed=true;clearTimeout(timer);void interaction.stop().then(()=>process.exit(0));});
interaction.ready.then(()=>console.log('DSH automatic interaction stream connected: '+base)).catch(()=>{});
await interaction.done;
