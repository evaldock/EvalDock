import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir,lstat} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
const root=path.resolve(import.meta.dirname,'../..');
const read=p=>readFile(path.join(root,p),'utf8');
async function files(relative){
  const result=[];
  for(const entry of await readdir(path.join(root,relative),{withFileTypes:true})){
    if(['var','dist','node_modules'].includes(entry.name))continue;
    const next=path.posix.join(relative,entry.name);
    assert.ok(!entry.isSymbolicLink(),`Unexpected symlink: ${next}`);
    if(entry.isDirectory())result.push(...await files(next));else result.push(next);
  }
  return result;
}
test('V2 source snapshots match the recorded committed bytes and contain only the reviewed files',async()=>{
  const manifest=JSON.parse(await read('research/v2/manifest.json'));
  assert.equal(manifest.status,'REFERENCE_ONLY_NOT_INTEGRATED');
  assert.deepEqual(manifest.modules.map(m=>m.name).sort(),['score-estimator','tag']);
  for(const module of manifest.modules){
    assert.match(module.sourceCommit,/^[a-f0-9]{40}$/);
    assert.equal(module.sourceFilesMatchCommit,true);
    const expected=[];
    for(const file of module.files){
      assert.equal(file.path,`${module.name}/${file.sourcePath}`);
      assert.ok(!file.path.split('/').some(p=>p==='..'||p===''));
      const relative='research/v2/'+file.path;
      assert.equal(createHash('sha256').update(await readFile(path.join(root,relative))).digest('hex'),file.sha256,relative);
      expected.push(relative);
    }
    assert.deepEqual((await files('research/v2/'+module.name)).sort(),expected.sort());
  }
});
test('V2 snapshots stay outside the normal build and application entry points',async()=>{
  const config=JSON.parse(await read('tsconfig.json'));
  assert.deepEqual(config.include,['src/**/*.ts','tests/**/*.ts','observer-lab/adapters/**/*.ts']);
  await assert.rejects(lstat(path.join(root,'dist/research')),{code:'ENOENT'});
  const pattern=/research[\\/]v2|score-estimator|evaluation[\\/]tag(?:[\\/."']|$)|copy-tag-assets/;
  const pkg=JSON.parse(await read('package.json'));
  assert.ok(!pattern.test(JSON.stringify({scripts:pkg.scripts,bin:pkg.bin,exports:pkg.exports})));
  for(const dir of ['src','adapters','workbench','scripts','.github/workflows']){
    for(const file of await files(dir)){
      if(!/\.(ts|mjs|js|json|html|ya?ml)$/.test(file)||file.includes('/native-probe/lib/'))continue;
      assert.ok(!pattern.test(await read(file)),`Active application references V2 snapshot: ${file}`);
    }
  }
});
