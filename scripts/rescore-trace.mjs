#!/usr/bin/env node
import {rescoreArchivedTrace} from '../dist/src/evaluation/rescore.js';
import {loadModelEnvironment} from '../dist/src/platform/model-environment.js';
const usage='Usage: pnpm rescore --report /path/to/case/report.json [--revision rubric-v2] [--labels labels] [--label label.id/v1]';
const args=process.argv.slice(2),options={};
try {
  if(args.length===1 && args[0]==='--help'){console.log(usage);process.exit(0);}
  for(let i=0;i<args.length;i+=2){
    if(!['--report','--revision','--labels','--label'].includes(args[i])||!args[i+1]||Object.hasOwn(options,args[i]))throw Error('Invalid arguments');
    options[args[i]]=args[i+1];
  }
  if(!options['--report'])throw Error('Report required');
  await loadModelEnvironment(process.env);
  const abort=new AbortController();
  process.once('SIGINT',()=>abort.abort());process.once('SIGTERM',()=>abort.abort());
  const {result,revisionDirectory}=await rescoreArchivedTrace({reportFile:options['--report'],
    ...(options['--revision']?{revisionId:options['--revision']} : {}),
    ...(options['--labels']?{labelsRoot:options['--labels']} : {}),
    ...(options['--label']?{labelIds:[options['--label']]} : {}),signal:abort.signal});
  console.log(JSON.stringify({status:result.status,revisionDirectory}));
  if(result.status!=='COMPLETE')process.exitCode=1;
} catch {console.error(usage+'\nRe-scoring failed. Check the verified archive, label selection, Judge settings, and a fresh revision ID. A started revision retains its failure marker and request audits.');process.exitCode=1;}
