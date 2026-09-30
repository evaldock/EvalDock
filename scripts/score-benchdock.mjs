#!/usr/bin/env node
import {writeFile} from 'node:fs/promises';
import {scoreBenchDockReport} from '../dist/src/evaluation/benchdock.js';
import {createDefaultLabelJudge} from '../dist/src/evaluation/llm-label-judge.js';
import {loadModelEnvironment} from '../dist/src/platform/model-environment.js';
const args=process.argv.slice(2), options={};
try {
  for(let i=0;i<args.length;i+=2){
    if(!['--report','--reference','--output'].includes(args[i])||!args[i+1]||options[args[i]])throw Error('Invalid arguments');
    options[args[i]]=args[i+1];
  }
  if(Object.keys(options).length!==3)throw Error('Usage: node scripts/score-benchdock.mjs --report report.json --reference private-bundle.json --output scores.json');
  await loadModelEnvironment(process.env);
  const result=await scoreBenchDockReport({reportFile:options['--report'],referenceFile:options['--reference'],judge:createDefaultLabelJudge()});
  await writeFile(options['--output'],JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
  console.log(JSON.stringify({status:result.scores.some(s=>s.status==='ERROR')?'SCORING_ERROR':'COMPLETE',taskId:result.taskId,output:options['--output']}));
  if(result.scores.some(s=>s.status==='ERROR'))process.exitCode=1;
} catch { console.error('BenchDock scoring failed. Check arguments, matching task revision, verified trace, Judge configuration and a fresh output path. Private reference content is not logged.');process.exitCode=1; }
