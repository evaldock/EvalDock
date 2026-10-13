import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {DesktopUpdates,updateEligible} from '../../desktop/updates.mjs';

function fixture({enabled=true,busy=false,failDownload=false}={}){
  const updater=new EventEmitter(),calls=[];
  updater.checkForUpdates=async()=>{calls.push('check');updater.emit('checking-for-update');updater.emit('update-available',{version:'0.2.0'});};
  updater.downloadUpdate=async()=>{calls.push('download');if(failDownload)throw Error('Synthetic error with secret');updater.emit('download-progress',{percent:60});updater.emit('update-downloaded',{version:'0.2.0'});};
  updater.quitAndInstall=()=>calls.push('install');
  const updates=new DesktopUpdates({updater,enabled,version:'0.1.0',canInstall:async()=>!busy,beforeInstall:async()=>calls.push('stop-backend')});
  return {updater,updates,calls};
}
test('developer builds and ad-hoc signatures do not enable automatic installation',async()=>{
  const signature='Authority=Developer ID Application: Synthetic Company\nTeamIdentifier=ABCDEFGHIJ';
  assert.equal(updateEligible({packaged:true,platform:'darwin',signature}),true);
  for(const input of [{packaged:false,platform:'darwin',signature},{packaged:true,platform:'linux',signature},{packaged:true,platform:'darwin',signature:'Signature=adhoc\nTeamIdentifier=not set'}])assert.equal(updateEligible(input),false);
  const f=fixture({enabled:false});assert.equal((await f.updates.check()).state,'DISABLED');assert.deepEqual(f.calls,[]);
});
test('checking, downloading and installing are distinct, and installation stops the backend first',async()=>{
  const f=fixture();assert.equal(f.updater.autoDownload,false);assert.equal(f.updater.autoInstallOnAppQuit,false);assert.equal(f.updater.allowDowngrade,false);
  assert.equal((await f.updates.check()).state,'AVAILABLE');assert.deepEqual(f.calls,['check']);
  assert.equal((await f.updates.download()).state,'READY');assert.deepEqual(f.calls,['check','download']);
  await f.updates.install();assert.deepEqual(f.calls,['check','download','stop-backend','install']);
});
test('active evaluations prevent installation; failed downloads remain retryable without exposing errors',async()=>{
  const busy=fixture({busy:true});await busy.updates.check();await busy.updates.download();
  await assert.rejects(busy.updates.install(),/等待评测/);assert.equal(busy.updates.status().state,'READY');assert.ok(!busy.calls.includes('install'));
  const failed=fixture({failDownload:true});await failed.updates.check();assert.equal((await failed.updates.download()).state,'FAILED');assert.doesNotMatch(JSON.stringify(failed.updates.status()),/Synthetic|secret/);
  assert.equal((await failed.updates.check()).state,'AVAILABLE');await assert.rejects(failed.updates.install());
});
