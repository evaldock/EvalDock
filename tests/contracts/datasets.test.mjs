import test from 'node:test';import assert from 'node:assert/strict';import path from 'node:path';import {writeFile} from 'node:fs/promises';
import {temporary,question,json} from './support.mjs';
import {loadDatasetCase,countDatasetQuestionCases} from '../../dist/src/datasets/loader.js';
test('Loader discovers an evolving dataset and separates public inputs from private grading',async t=>{
 const root=await temporary(t);await question(root,1);assert.equal(await countDatasetQuestionCases(root,'dataset.example/v1'),1);
 await question(root,2);assert.equal(await countDatasetQuestionCases(root,'dataset.example/v1'),2);
 const value=await loadDatasetCase({datasetsRoot:root,datasetId:'dataset.example/v1',labelIds:['label.contract/v1'],caseIndex:1});
 assert.equal(value.grading.weight,2);assert.equal(value.grading.reference.answer,'private answer');
 assert.ok(!JSON.stringify(value.seedEntries).includes('private answer'));
});
test('changed input bytes and paths outside input are rejected',async t=>{
 const root=await temporary(t),{dir,q}=await question(root);
 await writeFile(path.join(dir,'input/data.txt'),'tampered');
 await assert.rejects(loadDatasetCase({datasetsRoot:root,datasetId:'dataset.example/v1',labelIds:['label.contract/v1']}));
 q.inputs[0].destination='../escape';await json(path.join(dir,'question.json'),q);
 await assert.rejects(loadDatasetCase({datasetsRoot:root,datasetId:'dataset.example/v1',labelIds:['label.contract/v1']}));
});
