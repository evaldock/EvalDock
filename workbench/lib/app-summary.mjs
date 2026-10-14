/** The product home remains usable when one Agent is missing or offline. */
export async function appSummary({control,workbuddy,agents}) {
  const entries=[['dsh',control],['workbuddy',workbuddy],...Object.entries(agents)];
  const statuses=await Promise.all(entries.map(async([kind,c])=>{
    try {
      const value=await c.status();
      if(kind==='dsh')return {kind,targets:[{id:'dsh',name:'DSH',evaluationReady:value.status==='RUNNING'&&!value.error&&value.modelReady===true&&!value.needsRestart&&!value.busy&&!value.externalEval&&!(value.runningSessions>0),reasonCode:value.error??(value.needsRestart?'DSH 配置已变化，请重启服务':!value.modelReady?'请配置 Planner / Judge 模型':value.busy||value.externalEval||value.runningSessions>0?'DSH 正在执行任务或操作':'请在高级工作台检查 DSH 配置')}],advanced:true};
      return {kind,targets:value.targets??[{id:kind,name:'WorkBuddy',...value}],active:!!c.active};
    } catch {return {kind,advanced:kind==='dsh',targets:[],error:'尚未配置或暂时无法连接'};}
  }));
  const records=await Promise.all(entries.map(async([kind,c])=>{
    try {
      if(c.records)return {...await c.records(),kind};
      const owned=[...c.jobs.jobs.values()].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,50);
      return {kind,jobs:owned.map(j=>({...c.jobs.view(j),agentKind:kind})),runs:await Promise.all(owned.map(j=>c.results.get(j)))};
    } catch {return {kind,jobs:[],runs:[],error:kind+' 的记录暂时无法读取'};}
  }));
  // DSH also discovers disk archives belonging to sibling Agents. Prefer each
  // Agent's controller record and preserve runs with the same ID on other targets.
  const jobs=new Map(),runs=new Map();
  for(const record of records){
    for(const job of record.jobs)jobs.set(JSON.stringify([job.targetId??job.agentKind??record.kind,job.runId??job.id]),job);
    for(const run of record.runs)runs.set(JSON.stringify([run.agentId??run.agentKind??record.kind,run.run.id]),run);
  }
  return {agents:statuses,jobs:[...jobs.values()].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)),runs:[...runs.values()],errors:records.flatMap(r=>r.error?[r.error]:[])};
}
