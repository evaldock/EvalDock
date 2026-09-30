
import path from 'node:path';
import {dirs,jsonFile,token,confined} from './files.mjs';
export async function listRuns(roots){
  const items=[];
  for(const [store,root] of Object.entries(roots))for(const agent of await dirs(path.join(root,'agents')))for(const run of await dirs(path.join(root,'agents',agent,'runs'))){
    const rel=path.join('agents',agent,'runs',run);
    try{
      await confined(root,rel);
      let data=null;try{data=await jsonFile(root,path.join(rel,'run.json'));}catch(e){if(e.code!=='ENOENT')throw e;}
      items.push({store,agentId:agent,runId:run,status:data?.status??'CASE_RESULTS_ONLY',createdAt:data?.createdAt??null,
        links:{self:'/api/v1/runs/'+[store,agent,run].map(encodeURIComponent).join('/')}});
    }catch(e){if(!['ENOENT','PATH_ESCAPE'].includes(e.code))items.push({store,agentId:agent,runId:run,status:'UNREADABLE'});}
  }
  return items.sort((a,b)=>b.runId.localeCompare(a.runId));
}
export function runLocation(roots,store,agent,run){
  if(!Object.hasOwn(roots,store))throw Object.assign(new Error('Unknown result store'),{status:404,code:'STORE_NOT_FOUND'});
  return {root:roots[store],rel:path.join('agents',token(agent),'runs',token(run))};
}
export async function readRun(root,rel){
  await confined(root,rel);
  let summary=null;try{summary=await jsonFile(root,path.join(rel,'run.json'));}catch(e){if(e.code!=='ENOENT')throw e;}
  return {summary,caseIds:await dirs(path.join(root,rel,'cases'))};
}
