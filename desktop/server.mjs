import {startControlServer} from '../workbench/control-server.mjs';
const runtime=await startControlServer({root:process.cwd(),port:0});
process.send?.({type:'ready',port:runtime.server.address().port});
let closing=false;
async function stop(){
  if(closing)return;closing=true;
  await Promise.all([runtime.control,runtime.workbuddy,...Object.values(runtime.agents)].map(c=>c.jobs.shutdown()));
  runtime.server.close(()=>process.exit(0));runtime.server.closeAllConnections();
}
process.on('message',message=>{if(message==='stop')void stop();});
process.once('SIGTERM',()=>void stop());process.once('SIGINT',()=>void stop());
