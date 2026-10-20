import {execFileSync} from 'node:child_process';
import {cp,mkdir,rm,writeFile,readFile,realpath,access} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';

const root=fileURLToPath(new URL('../',import.meta.url));
const out=path.resolve(process.argv[2]??'artifacts/core-runtime');
if(root.startsWith(out+path.sep)||out===path.resolve(root))throw Error('Choose an output directory outside the core source.');
execFileSync(process.execPath,['scripts/check-publication-boundary.mjs'],{cwd:root,stdio:'inherit'});
await rm(out,{recursive:true,force:true});await mkdir(out,{recursive:true});
const tracked=execFileSync('git',['ls-files','-z'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean);
for(const file of tracked){
  if(!/^(adapters|workbench|labels|planning|trace|observer-lab|src|config|datasets|environments)\//.test(file))continue;
  if(file==='config/agents.json'||file.startsWith('workbench/tests/')||file.endsWith('.test.mjs'))continue;
  await mkdir(path.dirname(path.join(out,file)),{recursive:true});
  await cp(path.join(root,file),path.join(out,file));
}
for(const name of ['src','observer-lab'])await cp(path.join(root,'dist',name),path.join(out,'dist',name),{recursive:true});
await cp(path.join(root,'src/agent-trace/native-probe/lib'),path.join(out,'src/agent-trace/native-probe/lib'),{recursive:true});
await writeFile(path.join(out,'package.json'),JSON.stringify({type:'module',private:true}));
await writeFile(path.join(out,'core-runtime.json'),JSON.stringify({schema:'evaldock.core-runtime/v1',commit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim()},null,2)+'\n');
const copied=new Set();
async function copyDependency(name,from=path.join(root,'package.json')){
  if(copied.has(name))return;copied.add(name);
  const require=createRequire(from);let manifest;
  for(const base of require.resolve.paths(name)){
    const candidate=path.join(base,name,'package.json');
    if(await access(candidate).then(()=>true,()=>false)){manifest=await realpath(candidate);break;}
  }
  if(!manifest)throw Error('Missing core runtime dependency: '+name);
  await cp(path.dirname(manifest),path.join(out,'node_modules',name),{recursive:true,dereference:true});
  const pkg=JSON.parse(await readFile(manifest,'utf8'));
  for(const dependency of Object.keys(pkg.dependencies??{}))await copyDependency(dependency,manifest);
}
for(const name of ['typescript','@deepseek-ai/schemastery','undici'])await copyDependency(name);
console.log('Core runtime exported.');
