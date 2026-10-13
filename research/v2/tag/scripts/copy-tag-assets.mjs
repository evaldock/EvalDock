import {cp,mkdir} from 'node:fs/promises';
await mkdir('dist/src/evaluation/tag/assets',{recursive:true});
await cp('src/evaluation/tag/assets','dist/src/evaluation/tag/assets',{recursive:true});

await mkdir('dist/src/evaluation/assets',{recursive:true});
await cp('src/evaluation/assets','dist/src/evaluation/assets',{recursive:true});
