#!/usr/bin/env node
/** Repository policy: real benchmark packages belong in a separately reviewed data release. */
import {execFileSync} from 'node:child_process';
import {readFile,access} from 'node:fs/promises';
import path from 'node:path';
const files=execFileSync('git',['ls-files','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);
const demo=new Set(['datasets/catalog.md','datasets/README.md','datasets/basic-file-delivery/case-001/question.json',
  'datasets/basic-file-delivery/case-001/input/numbers.json','datasets/basic-file-delivery/case-001/private/final.json']);
const failures=[];
for(const file of files){
  try{await access(file);}catch{continue;} // A reviewed removal may not yet be staged locally.
  if(["docs/assets/workbench-evidence.png","scripts/import-harbor-nonduplicate.py","docs-simple/DATASET_EXAMPLE.md"].includes(file))failures.push(file);
  if(file.startsWith('datasets/')&&!demo.has(file))failures.push(file);
  if(file.startsWith('environments/')&&file!=='environments/macos.json')failures.push(file);
  if(file.startsWith('workbench/design-prototypes/question-inventory/cases/'))failures.push(file);
  if(file.includes('/private/')&&!file.startsWith('examples/datasets/minimal/')&&!file.startsWith('tests/fixtures/datasets/attention-pytorch/')&&!demo.has(file))failures.push(file);
  if(file==='docs/assets/workbench-evidence.png')failures.push(file);
}
for(const file of demo){
  if(file==='datasets/README.md')continue;
  const original=path.join('examples/datasets/minimal',file.slice('datasets/'.length));
  if(!(await readFile(file)).equals(await readFile(original)))failures.push(file+' differs from synthetic demo');
}
const inventory=JSON.parse(await readFile('workbench/design-prototypes/question-inventory/index.json','utf8'));
if(inventory.datasets.length)failures.push('Static task inventory must not embed benchmark content');
const difficulty=JSON.parse(await readFile('planning/case-difficulty.json','utf8'));
if(difficulty.cases.length)failures.push('Real task difficulty hints belong outside the public framework');
for(const file of ['workbench/design-prototypes/index.html','workbench/design-prototypes/catalog-snapshot.js']){
  const text=await readFile(file,'utf8'),match=text.match(/const resourceSnapshot = (.*);/);
  if(match&&JSON.parse(match[1]).datasets.length)failures.push(file+' contains static benchmark catalog');
}
const historical=await readFile('workbench/design-prototypes/historical-snapshot.js','utf8');
  const historicalMatch=historical.match(/const historicalAgents\s*=\s*(\[.*\]);/s);
  if(!historicalMatch||JSON.parse(historicalMatch[1]).length)failures.push('Historical preview must not embed real task runs');
  if(failures.length){console.error('Publication boundary failed:\n'+[...new Set(failures)].join('\n'));process.exitCode=1;}
else console.log('Publication boundary passed: framework + explicit synthetic fixtures only. Git history is not audited by this check.');
