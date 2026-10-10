import test from 'node:test';import assert from 'node:assert/strict';
import {desktopConnection} from '../../adapters/workbuddy/desktop.mjs';
import {inspectWorkBuddy} from '../../adapters/workbuddy/status.mjs';
import {createWorkBuddyAdapter} from '../../adapters/workbuddy/adapter.mjs';
test('isolated WorkBuddy installs bind one exact renderer to a local endpoint',()=>{
 assert.deepEqual(desktopConnection(),{endpoint:'http://127.0.0.1:18491',renderer:'file:///Applications/WorkBuddy.app/Contents/Resources/app.asar/renderer/index.html'});
 assert.equal(desktopConnection({appPath:'/synthetic/old version/WorkBuddy.app',endpoint:'http://127.0.0.1:18494'}).renderer,'file:///synthetic/old%20version/WorkBuddy.app/Contents/Resources/app.asar/renderer/index.html');
 for(const endpoint of ['https://127.0.0.1:18494','http://example.com','http://user:pass@localhost','http://localhost/api'])assert.throws(()=>desktopConnection({endpoint}),/INVALID_ENDPOINT/);
 assert.throws(()=>desktopConnection({appPath:'WorkBuddy.app'}),/INVALID_ENDPOINT/);
});
test('WorkBuddy inspection reads the selected bundle and preserves identity checks',async()=>{
 let inspected;const common={appPath:'/synthetic/WorkBuddy.app',execCommand:async(_cmd,args)=>{inspected=args.at(-1);return {stdout:JSON.stringify({CFBundleShortVersionString:'5.7.7',CFBundleIdentifier:'com.tencent.workbuddy.mac'})};},connect:async()=>({authenticated:async()=>true,close(){}})};
 const state=await inspectWorkBuddy(common);assert.equal(state.installRoot,common.appPath);assert.equal(state.version,'5.7.7');assert.equal(state.evaluationReady,true);assert.equal(inspected,common.appPath+'/Contents/Info.plist');
 const invalid=await inspectWorkBuddy({...common,execCommand:async()=>({stdout:JSON.stringify({CFBundleIdentifier:'other'})})});assert.equal(invalid.reasonCode,'WORKBUDDY_APP_ID_MISMATCH');
 assert.equal(createWorkBuddyAdapter({targetId:'matrix-workbuddy',appPath:common.appPath}).targetId,'matrix-workbuddy');
});
