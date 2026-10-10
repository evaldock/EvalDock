import test from 'node:test';import assert from 'node:assert/strict';import path from 'node:path';import {mkdir,writeFile,cp,rm} from 'node:fs/promises';import {pathToFileURL} from 'node:url';
import {temporary,json,root} from './support.mjs';
import {loadObserverRegistry} from '../../dist/src/observation/registry.js';
import {startLabObservers} from '../../dist/src/observation/collection.js';
async function adapter(base,name,sourceType,enabled=true,fail=false){
 const dir=path.join(base,'observer-lab/adapters',name);await mkdir(dir,{recursive:true});
 await json(path.join(dir,'manifest.json'),{sourceType,implementationId:'contract.'+name,implementationVersion:'1',capabilities:['VALUE'],enabled});
 const core=pathToFileURL(path.join(root,'observer-lab/lib/core.mjs')).href;
 await writeFile(path.join(dir,'index.mjs'),`import {readFile} from 'node:fs/promises';import {observation} from ${JSON.stringify(core)};export const capabilities=['VALUE'];export function prepareConfig(c,r){return {...c,file:r.workspacePath+'/value'};}export async function capture({phase,config}){${fail?"throw new Error('adapter failed');":""}const at=new Date().toISOString();return observation(${JSON.stringify(name)},phase,{value:await readFile(config.file,'utf8')},[],at,at,capabilities);}`);
}
test('Observer registration supports arbitrary additions, removal, pause and rejects ambiguity',async t=>{
 const dir=await temporary(t);await adapter(dir,'alpha','CUSTOM_ALPHA');await adapter(dir,'paused','CUSTOM_PAUSED',false);
 let registry=await loadObserverRegistry(dir);assert.equal(registry.find(r=>r.component==='paused').enabled,false);
 await adapter(dir,'beta','CUSTOM_BETA');registry=await loadObserverRegistry(dir);assert.equal(registry.length,3);
 await rm(path.join(dir,'observer-lab/adapters/alpha'),{recursive:true});assert.equal((await loadObserverRegistry(dir)).length,2);
 await adapter(dir,'duplicate','CUSTOM_BETA');await assert.rejects(loadObserverRegistry(dir),/Duplicate/);
});
test('new Observer executes without Workflow edits; failure is isolated and stop is idempotent',async t=>{
 const dir=await temporary(t);await adapter(dir,'custom','CUSTOM');await adapter(dir,'broken','BROKEN',true,true);await adapter(dir,'paused','PAUSED',false);
 await cp(path.join(root,'observer-lab/lib'),path.join(dir,'observer-lab/lib'),{recursive:true});
 await cp(path.join(root,'observer-lab/bin'),path.join(dir,'observer-lab/bin'),{recursive:true});
 await cp(path.join(root,'observer-lab/adapters/index.mjs'),path.join(dir,'observer-lab/adapters/index.mjs'));
 await json(path.join(dir,'observer-lab/config/macos-worker.json'),{components:{custom:{enabled:true},broken:{enabled:true},paused:{enabled:false}}});
 await writeFile(path.join(dir,'value'),'before');
 const registry=await loadObserverRegistry(dir);
 const requirements=registry.map(r=>({sourceType:r.sourceType,sensorImplementationId:r.implementationId,requiredCapabilities:r.capabilities}));
 const run=await startLabObservers({cwd:dir,outputDirectory:path.join(dir,'capture'),caseId:'case',agentId:'agent',requirements,workspacePath:dir,observedUid:process.getuid(),attemptId:'attempt',maxFileBytes:10000});
 await writeFile(path.join(dir,'value'),'after');
 const stopped=run.stop();assert.equal(run.stop(),stopped);const captures=await stopped;
 assert.ok(captures.find(c=>c.component==='custom').events.length>0);
 assert.equal(captures.find(c=>c.component==='broken').complete,false);
 assert.ok(!captures.some(c=>c.component==='paused'));
});
