import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile,writeFile,cp,rm} from 'node:fs/promises';
import vm from 'node:vm';
import {temporary,question,json,judgeInput} from './support.mjs';
import {startControlServer} from '../../workbench/control-server.mjs';

async function fixture(t){
 const root=await temporary(t),{dir,q}=await question(path.join(root,'datasets'));
 q.grading={reference:'private/final.json',criteria:[{prompt:'SYNTHETIC_PRIVATE_INVENTORY_SENTINEL'}]};q.evidence={privateGuidance:'SYNTHETIC_PRIVATE_INVENTORY_SENTINEL'};
 await json(path.join(dir,'question.json'),q);
 await json(path.join(root,'workbench/design-prototypes/question-inventory/index.json'),{capturedAt:null,datasets:[],labels:[judgeInput().label]});
 await writeFile(path.join(root,'datasets/catalog.md'),'```json evaldock-dataset-catalog\n'+JSON.stringify({schema:'evaldock.dataset-planner-catalog/v1',version:'1',datasets:[{datasetId:'dataset.example/v1',name:'Synthetic inventory',description:'Contract fixture',labelIds:['label.contract/v1'],availableCaseCount:1}]})+'\n```');
 const quiet={status:async()=>{throw Error('No Agent probe is allowed');}};
 const {server}=await startControlServer({root,port:0,controller:quiet,workbuddyController:quiet,agentControllers:{},modelSettingsFile:path.join(root,'models.env'),agentModelSettings:{init:async()=>{}}});
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 return {root,dir,q,origin:'http://127.0.0.1:'+server.address().port};
}
test('advanced inventory and the main catalog read the same installed synthetic library',async t=>{
 const {origin}=await fixture(t);
 const catalog=await(await fetch(origin+'/api/control/evaluation-catalog')).json();
 const response=await fetch(origin+'/question-inventory/index.json');assert.equal(response.status,200);const inventory=await response.json();
 assert.equal(catalog.datasets[0].cases.length,1);
 assert.deepEqual(inventory.datasets.map(d=>({id:d.id,count:d.cases.length})),catalog.datasets.map(d=>({id:d.id,count:d.cases.length})));
 assert.equal(inventory.datasets[0].cases[0].caseId,catalog.datasets[0].cases[0].id);
 assert.equal(inventory.labels[0].labelId,'label.contract/v1');
});
test('inventory details expose public inputs and reference status while preserving private source files',async t=>{
 const {origin,root,dir,q}=await fixture(t),privateFile=path.join(dir,'private/final.json'),definition=path.join(dir,'question.json');
 await json(privateFile,{answer:'SYNTHETIC_PRIVATE_INVENTORY_SENTINEL'});
 q.inputs[0].answer='SYNTHETIC_PRIVATE_INVENTORY_SENTINEL';q.inputs.push({source:'private/final.json',destination:'private/final.json'});await json(definition,q);
 const before=[await readFile(definition),await readFile(privateFile)],staticIndex=await readFile(path.join(root,'workbench/design-prototypes/question-inventory/index.json'));
 const index=await(await fetch(origin+'/question-inventory/index.json')).json(),meta=index.datasets[0].cases[0];
 const response=await fetch(origin+'/question-inventory/cases/'+meta.file);assert.equal(response.status,200);const record=await response.json();
 assert.equal(record.question.task.instructions,'Read the input');assert.equal(record.question.environment.platform,'portable');assert.equal(record.question.inputs.length,1);
 assert.equal(record.scoringState,'READY');assert.equal(record.question.grading,undefined);assert.equal(record.question.evidence,undefined);assert.deepEqual(record.documents,{});
 assert.ok(!JSON.stringify({index,record}).includes('SYNTHETIC_PRIVATE_INVENTORY_SENTINEL'));assert.ok(!JSON.stringify(record).includes('private/final.json'));
 assert.deepEqual([await readFile(definition),await readFile(privateFile)],before);assert.deepEqual(await readFile(path.join(root,'workbench/design-prototypes/question-inventory/index.json')),staticIndex);
 assert.equal((await fetch(origin+'/question-inventory/index.json',{headers:{origin:'https://outside.invalid'}})).status,403);
 assert.equal((await fetch(origin+'/question-inventory/index.json',{method:'POST'})).status,405);
 assert.equal((await fetch(origin+'/question-inventory/cases/'+encodeURIComponent('../private/final.json'))).status,404);
});
test('inventory refresh reflects changed, added and removed local questions without stale detail paths',async t=>{
 const {origin,root,dir,q}=await fixture(t),url=origin+'/question-inventory/index.json';
 const old=await(await fetch(url)).json();q.task.instructions='Synthetic revised task';await json(path.join(dir,'question.json'),q);
 const extra=await question(path.join(root,'datasets'),2),next=await(await fetch(url)).json();
 assert.equal(next.datasets[0].cases.length,2);assert.notEqual(next.revision,old.revision);
 assert.equal((await fetch(origin+'/question-inventory/cases/'+old.datasets[0].cases[0].file)).status,404);
 const detail=await(await fetch(origin+'/question-inventory/cases/'+next.datasets[0].cases[0].file)).json();assert.equal(detail.question.task.instructions,'Synthetic revised task');
 await rm(path.join(extra.dir,'question.json'));assert.equal((await(await fetch(url)).json()).datasets[0].cases.length,1);
 await cp('desktop/empty-library/catalog.md',path.join(root,'datasets/catalog.md'));
 assert.deepEqual((await(await fetch(url)).json()).datasets,[]);assert.deepEqual((await(await fetch(origin+'/api/control/evaluation-catalog')).json()).datasets,[]);
 assert.equal((await fetch(origin+'/question-inventory/cases/'+next.datasets[0].cases[0].file)).status,404);
});
test('inventory and selection honor the same configured external dataset root',async t=>{
 const {origin,root}=await fixture(t),external=path.join(root,'synthetic-external-library'),previous=process.env.EVALDOCK_DATASETS_ROOT;
 await cp(path.join(root,'datasets'),external,{recursive:true});await question(external,2);
 process.env.EVALDOCK_DATASETS_ROOT=external;t.after(()=>{if(previous===undefined)delete process.env.EVALDOCK_DATASETS_ROOT;else process.env.EVALDOCK_DATASETS_ROOT=previous;});
 const catalog=await(await fetch(origin+'/api/control/evaluation-catalog')).json(),inventory=await(await fetch(origin+'/question-inventory/index.json')).json();
 assert.equal(catalog.datasets[0].cases.length,2);assert.deepEqual(inventory.datasets.map(d=>d.cases.length),catalog.datasets.map(d=>d.cases.length));
});
async function uiContext(){
 const source=await readFile('workbench/design-prototypes/question-inventory-ui.js','utf8');
 const context=vm.createContext({sessionStorage:{getItem:()=>null},document:{addEventListener(){}},setTimeout:()=>{},AbortSignal,page:'resources',selectedDataset:'dataset.synthetic/v1',render(){}});
 vm.runInContext(source,context);return context;
}
const uiIndex=file=>({datasets:[{id:'dataset.synthetic/v1',cases:[{caseId:'synthetic-case',file}]}],labels:[]});
test('refresh invalidates changed or removed case caches and preserves the last directory on failure',async()=>{
 const context=await uiContext();context.before=uiIndex('old.json');context.after=uiIndex('new.json');
 vm.runInContext("questionInventory.index=before;questionInventory.state.caseId='synthetic-case';questionInventory.cases.set('synthetic-case',{old:true})",context);
 context.fetch=async()=>({ok:true,json:async()=>context.after});await vm.runInContext('loadQuestionInventory()',context);
 assert.equal(vm.runInContext("questionInventory.cases.has('synthetic-case')",context),false);
 context.after={datasets:[],labels:[]};await vm.runInContext('loadQuestionInventory()',context);
 assert.equal(vm.runInContext('questionInventory.state.caseId',context),null);assert.equal(context.selectedDataset,'__inventory__');
 context.fetch=async()=>({ok:false});await vm.runInContext('loadQuestionInventory()',context);
 assert.equal(vm.runInContext('questionInventory.index.datasets.length',context),0);assert.equal(vm.runInContext('questionInventory.error',context),true);
});
test('a late detail response cannot replace the current library revision',async()=>{
 const context=await uiContext();context.before=uiIndex('old.json');context.after=uiIndex('new.json');let finish;
 const oldResponse=new Promise(resolve=>{finish=resolve;});
 vm.runInContext('questionInventory.index=before',context);
 context.fetch=async route=>route.includes('/cases/')?oldResponse:{ok:true,json:async()=>context.after};
 const request=vm.runInContext('loadInventoryCase(questionInventory.index.datasets[0].cases[0])',context);
 await vm.runInContext('loadQuestionInventory()',context);vm.runInContext("questionInventory.cases.set('synthetic-case',{current:true})",context);
 finish({ok:true,json:async()=>({stale:true})});await request;
 assert.equal(vm.runInContext("questionInventory.cases.get('synthetic-case').current",context),true);
});
