import {execFileSync} from 'node:child_process';
import {cp,mkdir,rm,writeFile,readFile,realpath,access} from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
const out=path.resolve('artifacts/desktop-runtime');
await rm(out,{recursive:true,force:true});await mkdir(out,{recursive:true});
// Only tracked public runtime resources plus explicitly built files enter the bundle.
const tracked=execFileSync('git',['ls-files','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);
for(const file of tracked){
  if(!/^(adapters|workbench|labels|planning|trace|observer-lab|src|config|datasets|environments)\//.test(file))continue;
  if(file==='config/agents.json'||file.startsWith('workbench/tests/'))continue;
  await mkdir(path.dirname(path.join(out,file)),{recursive:true});await cp(file,path.join(out,file));
}
// New product files are explicit, so staging also works before the first commit.
for(const file of ['adapters/hermes/session-evidence.py','adapters/compatibility/dsh.mjs','adapters/shared/factory.mjs','adapters/compatibility/contracts.mjs','adapters/compatibility/identity.mjs','adapters/compatibility/store.mjs','adapters/compatibility/check.mjs','adapters/compatibility/cli.mjs','workbench/design-prototypes/assets/evaldock-logo.png','adapters/langgraph/preflight.py','adapters/shared/cli-interface.mjs','workbench/design-prototypes/product-pages.js','workbench/design-prototypes/assets/agents/codex.png','workbench/design-prototypes/assets/agents/claude.png','workbench/lib/agent-discovery.mjs','workbench/lib/app-summary.mjs','workbench/control-server.mjs','desktop/server.mjs','workbench/design-prototypes/app.html','workbench/design-prototypes/app.css','workbench/design-prototypes/app.js']){
  await mkdir(path.dirname(path.join(out,file)),{recursive:true});await cp(file,path.join(out,file));
}
await cp('dist',path.join(out,'dist'),{recursive:true});
await cp('src/agent-trace/native-probe/lib',path.join(out,'src/agent-trace/native-probe/lib'),{recursive:true});
await writeFile(path.join(out,'package.json'),JSON.stringify({type:'module',private:true}));
console.log('Desktop runtime staged:',out);

const copied=new Set();
async function copyDependency(name,from=path.resolve('package.json')){
  if(copied.has(name))return;copied.add(name);
  const require=createRequire(from);let manifest;
  for(const base of require.resolve.paths(name)){const candidate=path.join(base,name,'package.json');if(await access(candidate).then(()=>true,()=>false)){manifest=candidate;break;}}
  if(!manifest)throw Error('Missing runtime dependency: '+name);
  manifest=await realpath(manifest);
  const directory=path.dirname(manifest);
  await cp(directory,path.join(out,'node_modules',name),{recursive:true,dereference:true});
  const pkg=JSON.parse(await readFile(manifest,'utf8'));
  for(const dependency of Object.keys(pkg.dependencies??{}))await copyDependency(dependency,manifest);
}
await copyDependency('typescript');await copyDependency('@deepseek-ai/schemastery');

await copyDependency('undici');

const {auditDesktopRuntime}=createRequire(import.meta.url)('./audit-desktop-runtime.cjs');
console.log('Audited desktop runtime files:',auditDesktopRuntime(out).length);
