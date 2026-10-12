import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {Jobs} from './jobs.mjs';

test('completed CLI summary survives numeric token settings in the redaction list',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'evaldock-job-summary-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const config=path.join(root,'config.json'),cli=path.join(root,'cli.mjs');
  await writeFile(config,'{}');
  const summary={schema:'evaldock.mvp.cli-summary/v1',status:'COMPLETED',diagnostics:{judgeContextTokens:1000000,judgeInputTokens:967232},message:'key is test-api-secret and Bearer bearer-fixture',apiKey:'test-api-secret',nested:[{password:123456,access_token:'test-api-secret',note:'quoted \"message\"\nline'}]};
  await writeFile(cli,'process.stdout.write('+JSON.stringify(JSON.stringify(summary)+'\n')+');');
  const jobs=new Jobs({repoRoot:root,stateRoot:path.join(root,'jobs'),targets:[{id:'fixture',config,descriptor:'fixture.json',fixture:true}],maxConcurrentJobs:1,cliPath:cli,cliPrefix:[cli],nodePath:process.execPath,secrets:['1000000','967232','test-api-secret']});
  await jobs.init();const started=await jobs.start({action:'run',targetId:'fixture'});
  const deadline=Date.now()+10000;while(jobs.children.size&&Date.now()<deadline)await delay(10);
  assert.equal(jobs.children.size,0);await jobs.writes;
  const job=jobs.get(started.id);assert.equal(job.exitCode,0);assert.equal(job.state,'SUCCEEDED');
  assert.deepEqual(job.summary.diagnostics,summary.diagnostics);
  assert.equal(job.summary.apiKey,'[REDACTED]');assert.equal(job.summary.nested[0].password,'[REDACTED]');
  assert.equal(job.summary.nested[0].access_token,'[REDACTED]');assert.equal(job.summary.nested[0].note,summary.nested[0].note);
  const saved=await readFile(path.join(root,'jobs',started.id+'.json'),'utf8');
  assert.ok(!saved.includes('test-api-secret'));assert.ok(!saved.includes('bearer-fixture'));
  for(const event of job.events){assert.ok(!event.text.includes('123456'));assert.ok(!event.text.includes('test-api-secret'));}
  assert.equal(JSON.parse(saved).summary.status,'COMPLETED');
});
