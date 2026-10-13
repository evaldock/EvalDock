/** Freeze one user choice across online preparation and the formal run. */
export function appEvaluationConfig({mode,selectionKind,caseCount,items=[]}) {
  if(!['EFFECT','FULL'].includes(mode))throw Error('请选择评测类型');
  let selection;
  if(selectionKind==='COUNT') {
    const count=Number(caseCount);
    if(!['number','string'].includes(typeof caseCount)||!Number.isInteger(count)||count<1||count>3)throw Error('少量评测请选择 1–3 道题');
    selection={kind:'COUNT',caseCount:count};
  } else if(selectionKind==='STANDARD')selection={kind:'STANDARD'};
  else if(selectionKind==='SELECTED') {
    if(!items.length)throw Error('请至少选择一道题目');
    selection={kind:'SELECTED',items:structuredClone(items)};
  } else throw Error('请选择选题方式');
  return {mode,selection};
}

export async function startAppEvaluation({agentKind,targetId,source,config},{api,prepareOnline}) {
  const evaluationConfig=structuredClone(config);
  if(evaluationConfig.selection.kind!=='SELECTED'&&source==='ONLINE') {
    await prepareOnline(agentKind,targetId,structuredClone(evaluationConfig));
  }
  const identity=agentKind==='dsh'?{revision:(await api('status')).revision}:agentKind==='workbuddy'?{}:{targetId};
  return api(agentKind==='dsh'?'run':agentKind+'/run',{...identity,evaluationConfig});
}
