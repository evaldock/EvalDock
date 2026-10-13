import test from 'node:test';
import assert from 'node:assert/strict';
import {renderAgentCards} from '../../workbench/design-prototypes/agent-cards.js';
import {appEvaluationConfig,startAppEvaluation} from '../../workbench/design-prototypes/app-evaluation.js';
import {friendlyMessage} from '../../workbench/design-prototypes/product-pages.js';

const brand={kind:'workbuddy',name:'WorkBuddy',format:'svg',description:'桌面任务与交付评测'};
const installed={id:'install-a',kind:'workbuddy',path:'/Applications/WorkBuddy.app',version:'5.7.7'};
const target={id:'workbuddy',kind:'workbuddy',name:'WorkBuddy',installRoot:installed.path,version:'5.7.7',status:'UNAVAILABLE',evaluationReady:false,checkedAt:'2026-10-13T00:00:00Z'};
const cards=(targets,installs=[installed])=>renderAgentCards({brands:[brand],targets,discovery:{agents:installs}});

test('unknown Agent failures retain a usable detail disclosure and retry action',()=>{
  const html=cards([{...target,reasonCode:'WORKBUDDY_FUTURE_FAILURE',apiKey:'synthetic-secret',reference:'synthetic-private'}]);
  assert.match(html,/<details[^>]*><summary>查看检查详情<\/summary>/);
  assert.match(html,/WORKBUDDY_FUTURE_FAILURE/);assert.match(html,/UNAVAILABLE/);
  assert.match(html,/data-refresh-agent/);assert.doesNotMatch(html,/data-start|data-open-agent/);
  assert.doesNotMatch(html,/synthetic-secret|synthetic-private|可评测/);
  assert.doesNotMatch(friendlyMessage('UNKNOWN_FAILURE'),/下方详情/);
});
test('connection, login and cleanup failures expose applicable recovery actions',()=>{
  assert.match(cards([{...target,reasonCode:'WORKBUDDY_NOT_CONNECTED'}]),/data-open-agent="workbuddy"/);
  const login=cards([{...target,reasonCode:'WORKBUDDY_LOGIN_REQUIRED'}]);
  assert.match(login,/完成登录/);assert.match(login,/登录后重新检查/);assert.doesNotMatch(login,/data-open-agent/);
  const cleanup=cards([{...target,reasonCode:'WORKBUDDY_CLEANUP_REQUIRED'}]);
  assert.match(cleanup,/data-agent-records/);assert.match(cleanup,/data-refresh-agent/);assert.doesNotMatch(cleanup,/data-start/);
  for(const reasonCode of ['WORKBUDDY_INTERFACE_CHANGED','WORKBUDDY_EVENT_TRANSPORT_UNAVAILABLE','WORKBUDDY_INSPECTION_FAILED']){
    const html=cards([{...target,reasonCode}]);assert.match(html,/data-refresh-agent/);assert.doesNotMatch(html,/可评测|data-start/);
  }
});
test('Agent diagnostic content and identifiers remain escaped',()=>{
  const html=cards([{...target,id:'<bad>',name:'<script>bad</script>',reasonCode:'<img onerror=bad>',version:'<version>'}]);
  assert.match(html,/&lt;script&gt;/);assert.match(html,/&lt;img onerror=bad&gt;/);
  assert.doesNotMatch(html,/<script>|<img onerror|<version>|<bad>/);
});
test('the ready target supplies both the card version and the evaluation action',()=>{
  const html=cards([{...target,id:'older',version:'5.5.6'},{...target,id:'current',version:'5.7.7',evaluationReady:true,status:'READY'}],[{...installed,version:'5.9.9'},installed]);
  assert.match(html,/data-target="current"/);assert.match(html,/5\.7\.7/);
  assert.doesNotMatch(html,/5\.5\.6|5\.9\.9/);assert.match(html,/可评测/);
});
test('a missing target version only falls back to the same discovered installation',()=>{
  const other={...installed,id:'other',path:'/Applications/WorkBuddy-other.app',version:'9.9.9'};
  for(const installs of [[other,installed],[installed,other]]){
    const html=cards([{...target,version:null}],installs);assert.match(html,/5\.7\.7（扫描）/);assert.doesNotMatch(html,/9\.9\.9/);
  }
  const unknown=cards([{...target,installRoot:'/Applications/Missing.app',version:null}],[other]);
  assert.match(unknown,/版本未读取/);assert.doesNotMatch(unknown,/9\.9\.9/);
});
test('discovery alone does not establish evaluation readiness and keeps connect identity bound',()=>{
  const html=cards([],[{...installed,target:{appPath:installed.path}}]);
  assert.match(html,/data-connect="install-a"/);assert.doesNotMatch(html,/可评测|data-start/);
});
test('small automatic evaluation accepts 1 to 3 cases and rejects invalid counts',()=>{
  for(const caseCount of [1,2,3,'1','2','3'])assert.deepEqual(appEvaluationConfig({mode:'FULL',selectionKind:'COUNT',caseCount}),{mode:'FULL',selection:{kind:'COUNT',caseCount:Number(caseCount)}});
  for(const caseCount of [0,4,-1,1.5,NaN,Infinity,'',undefined,null,true,[],{}])assert.throws(()=>appEvaluationConfig({mode:'FULL',selectionKind:'COUNT',caseCount}),/1–3/);
  assert.throws(()=>appEvaluationConfig({mode:'FULL',selectionKind:'OTHER'}),/选题方式/);
  assert.throws(()=>appEvaluationConfig({mode:'OTHER',selectionKind:'COUNT',caseCount:1}),/评测类型/);
});
test('the same bounded configuration reaches preparation and every formal controller',async()=>{
  for(const agentKind of ['pi','workbuddy','dsh'])for(const caseCount of [1,2,3]){
    const config=appEvaluationConfig({mode:'FULL',selectionKind:'COUNT',caseCount}),calls=[];
    await startAppEvaluation({agentKind,targetId:'target-a',source:'ONLINE',config},{
      prepareOnline:async(kind,id,value)=>{calls.push(['prepare',kind,id,value]);},
      api:async(route,body)=>{calls.push([route,body]);return {revision:7,result:{id:'job'}};}
    });
    assert.deepEqual(calls[0],['prepare',agentKind,'target-a',config]);
    const last=calls.at(-1);assert.equal(last[0],agentKind==='dsh'?'run':agentKind+'/run');
    assert.deepEqual(last[1].evaluationConfig,config);
    assert.equal(last[1].targetId,agentKind==='pi'?'target-a':undefined);
    if(agentKind==='dsh')assert.equal(last[1].revision,7);
  }
});
test('form changes during online preparation cannot change the formal mode or count',async()=>{
  const config=appEvaluationConfig({mode:'FULL',selectionKind:'COUNT',caseCount:2});let submitted;
  await startAppEvaluation({agentKind:'pi',targetId:'target-a',source:'ONLINE',config},{
    prepareOnline:async(kind,id,prepared)=>{assert.equal(prepared.selection.caseCount,2);await Promise.resolve();config.selection={kind:'STANDARD'};config.mode='EFFECT';prepared.selection.caseCount=70;},
    api:async(route,body)=>{submitted=body;return {};}
  });
  assert.deepEqual(submitted.evaluationConfig,{mode:'FULL',selection:{kind:'COUNT',caseCount:2}});
});
test('online failure or cancellation never starts a formal evaluation',async()=>{
  for(const message of ['线上准备失败','线上准备已取消']){
    let calls=0;
    await assert.rejects(startAppEvaluation({agentKind:'dsh',targetId:'dsh',source:'ONLINE',config:appEvaluationConfig({mode:'FULL',selectionKind:'COUNT',caseCount:1})},{prepareOnline:async()=>{throw Error(message);},api:async()=>{calls++;}}),new RegExp(message));
    assert.equal(calls,0);
  }
});
test('manual and local selection retain their existing controller routes without online preparation',async()=>{
  const items=[{datasetId:'synthetic',caseIndices:[0]}];
  for(const config of [appEvaluationConfig({mode:'EFFECT',selectionKind:'SELECTED',items}),appEvaluationConfig({mode:'FULL',selectionKind:'STANDARD'})]){
    let submitted;
    await startAppEvaluation({agentKind:'pi',targetId:'target-a',source:config.selection.kind==='SELECTED'?'ONLINE':'LOCAL',config},{prepareOnline:async()=>assert.fail('unexpected online preparation'),api:async(route,body)=>{submitted=body;}});
    assert.deepEqual(submitted.evaluationConfig,config);
  }
  assert.throws(()=>appEvaluationConfig({mode:'FULL',selectionKind:'SELECTED'}),/至少选择/);
});
