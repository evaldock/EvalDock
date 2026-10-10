import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {temporary,json} from './support.mjs';
import {inspectHeadlessInstallation} from '../../dist/src/runtime/headless-inspection.js';
test('installed headless profile exposes actual identity without inventing permissions or requiring a generated config',async t=>{
 const root=await temporary(t),sourceRoot=path.join(root,'install'),dshHome=path.join(root,'home');
 await json(path.join(sourceRoot,'package.json'),{version:'test-next'});
 const file=path.join(dshHome,'profiles/headless/package.json');
 await json(file,{dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-headless']}}});
 const d={sourceRoot,dshHome,profile:'headless'};
 const info=await inspectHeadlessInstallation(d);assert.equal(info.dshVersion,'test-next');assert.equal(info.permissionPreset,'UNKNOWN');assert.equal(info.probe.configured,false);
 await json(file,{dsh:{profile:{bundles:['@deepseek-ai/dsh-web-app']}}});await assert.rejects(inspectHeadlessInstallation(d),/HEADLESS_PROFILE_INVALID/);
});
