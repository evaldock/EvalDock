const activeStates = new Set(['STARTING', 'RUNNING', 'CANCELLING']);

// Keep a bounded entry per selected Case, independently of the rolling log tail.
export function recordCaseProgress(job, text, time) {
  if(text.startsWith('[evaldock:case] ')){
    let e;try{e=JSON.parse(text.slice(16));}catch{return;}
    const phases=new Set(['QUEUED','PREPARING','EXECUTING','COLLECTING','JUDGING','REPORTING','COMPLETED','FAILED','CANCELLED']);
    if(!Number.isSafeInteger(e.ordinal)||!Number.isSafeInteger(e.total)||e.ordinal<1||e.ordinal>e.total||e.total>10000||!phases.has(e.phase)||typeof e.caseId!=='string'||e.caseId.length>160||!Number.isFinite(Date.parse(e.at)))return;
    const p=job.caseProgress??={total:e.total,cases:{}};p.cases??={};p.planned??={};p.running??={};p.total=e.total;
    const old=p.cases[e.ordinal]??p.running[e.ordinal]??p.planned[e.ordinal]??{};
    if(old.updatedAt&&Date.parse(old.updatedAt)>Date.parse(e.at)||p.cases[e.ordinal]&&!['COMPLETED','FAILED','CANCELLED'].includes(e.phase))return;
    const row={...old,ordinal:e.ordinal,caseId:e.caseId,phase:e.phase,updatedAt:e.at};
    for(const key of ['datasetId','sessionId','labelId','reasonCode'])if(typeof e[key]==='string'&&e[key].length<=200)row[key]=e[key];
    if(e.phase!=='QUEUED')row.startedAt??=e.at;
    if(e.phase==='JUDGING'&&Number.isSafeInteger(e.labelIndex)&&Number.isSafeInteger(e.labelCount)){row.labelIndex=e.labelIndex;row.labelCount=e.labelCount;}
    if(e.phase==='QUEUED')p.planned[e.ordinal]=row;
    else if(['COMPLETED','FAILED','CANCELLED'].includes(e.phase)){p.cases[e.ordinal]={...row,status:e.phase,endedAt:e.at};delete p.running[e.ordinal];}
    else p.running[e.ordinal]=row;
    p.current=Object.values(p.running).sort((a,b)=>a.ordinal-b.ordinal)[0]??null;return;
  }
  const match = /^\[evaldock:batch\] (starting|finished) (\d+)\/(\d+): (\S+?)(?: \(([^)]+)\))?$/.exec(text);
  if (!match) return;
  const [, action, ordinalText, totalText, caseId, status] = match;
  const ordinal = Number(ordinalText), total = Number(totalText);
  if (ordinal < 1 || ordinal > total || total > 10000) return;
  const progress = job.caseProgress ??= { total, cases: {} };
  progress.cases ??= {};
  progress.total = total;
  progress.running ??= {};
  if (action === 'finished') {
    progress.cases[ordinal] = { ...progress.planned?.[ordinal],...progress.running[ordinal],...progress.cases[ordinal],ordinal,caseId, status: status || 'UNKNOWN',phase:status||'UNKNOWN',...(time?{endedAt:time}:{}) };
    delete progress.running[ordinal];
  } else if (!progress.cases[ordinal]) progress.running[ordinal] = { ...progress.planned?.[ordinal],...progress.running[ordinal],ordinal, caseId,phase:progress.running[ordinal]?.phase??'RUNNING',...(time&&!progress.running[ordinal]?.startedAt?{startedAt:time}:{}) };
  progress.current = Object.values(progress.running).sort((a,b)=>a.ordinal-b.ordinal)[0] ?? null;
}

export function runProgress(job) {
  const recovered = { caseProgress: job.caseProgress ? structuredClone(job.caseProgress) : undefined };
  for (const event of job.events ?? []) if (event.kind === 'stderr') recordCaseProgress(recovered, event.text, event.time);
  const p = recovered.caseProgress;
  const finalCases = job.summary?.caseResults;
  const entries = Array.isArray(finalCases) && finalCases.length ? finalCases : Object.values(p?.cases ?? {});
  const total = p?.total || job.scale?.caseCount || job.request?.caseCount || job.summary?.totalCaseCount || null;
  const ended = entries.length;
  const normal = entries.filter(c => c.status === 'COMPLETED').length;
  const cancelled = entries.filter(c => c.status === 'CANCELLED').length;
  const failed = entries.filter(c => !['COMPLETED', 'CANCELLED', 'UNKNOWN'].includes(c.status)).length;
  const active = activeStates.has(job.state);
  const currentCases = active ? Object.values(p?.running ?? (p?.current ? {[p.current.ordinal]:p.current} : {})).filter(c=>!p?.cases?.[c.ordinal]).sort((a,b)=>a.ordinal-b.ordinal) : [];
  const caseRows=Object.values({...p?.planned,...p?.running,...p?.cases}).sort((a,b)=>a.ordinal-b.ordinal);
  for(const [index,c] of (finalCases??[]).entries()){const row=caseRows.find(r=>r.caseId===c.caseId);if(row)Object.assign(row,{status:c.status,phase:c.status,reasonCode:c.reasonCodes?.[0]??row.reasonCode});else caseRows.push({ordinal:index+1,caseId:c.caseId,datasetId:c.datasetId,phase:c.status,status:c.status,reasonCode:c.reasonCodes?.[0]});}
  if(!active)for(const row of caseRows)if(!row.status)row.phase='NOT_FINISHED';
  let label = '正在准备', tone = 'running';
  if (job.state === 'CANCELLING') label = '正在结束 · 等待收尾';
  else if (active && total && ended >= total) label = '汇总收尾中';
  else if (active && p?.current) label = 'Case 执行与评分中';
  else if (active) label = '正在规划测试';
  else if (job.state === 'INTERRUPTED') { label = '运行状态待确认'; tone = 'warning'; }
  else if (job.state === 'CANCELLED') { label = job.cancelRequestedAt ? '本轮已手动结束' : '本轮已取消'; tone = 'warning'; }
  else if (job.state === 'SUCCEEDED') { label = '本轮已完成'; tone = 'done'; }
  else if (job.state === 'FAILED') { label = total && ended >= total ? '本轮已结束 · 有异常' : '本轮已结束 · 未全部完成'; tone = 'warning'; }
  return { total, ended, normal, failed, cancelled, unknown: ended-normal-failed-cancelled,
    remaining: total === null ? null : Math.max(0,total-ended),
    percent: total ? Math.min(100, Math.round(ended/total*100)) : 0,
    current: currentCases[0] ?? null, currentCases, cases:caseRows,
    active, label, tone, countsComplete: !!finalCases?.length || !job.eventsTruncated || !!job.caseProgress };
}
