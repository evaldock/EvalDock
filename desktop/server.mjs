import {startControlServer} from '../workbench/control-server.mjs';
import {BenchDockLibrary} from '../workbench/lib/benchdock-library.mjs';
let runtime;
const library=new BenchDockLibrary({root:process.cwd(),automatic:process.env.EVALDOCK_AUTO_DATASETS==='1',canInstall:async()=>!runtime.hasPendingMutations()&&![runtime.control,runtime.workbuddy,...Object.values(runtime.agents)].some(c=>c.active||[...c.jobs.jobs.values()].some(j=>['STARTING','RUNNING','CANCELLING'].includes(j.state)))});
await library.init();
runtime=await startControlServer({root:process.cwd(),port:0,libraryService:library});
process.send?.({type:'ready',port:runtime.server.address().port});
library.loadCatalog();
let closing=false;
async function stop(){
  if(closing)return;closing=true;
  await library.close();
  await Promise.all([runtime.control,runtime.workbuddy,...Object.values(runtime.agents)].map(c=>c.jobs.shutdown()));
  runtime.server.close(()=>process.exit(0));runtime.server.closeAllConnections();
}
process.on('message',message=>{if(message==='stop')void stop();});
process.once('SIGTERM',()=>void stop());process.once('SIGINT',()=>void stop());
