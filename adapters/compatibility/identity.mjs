import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createReadStream} from 'node:fs';
import {readdir,lstat,realpath} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import os from 'node:os';
import {PROTOCOLS,SUITE_VERSION} from './contracts.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
export const hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
async function digest(file){const h=createHash('sha256');for await(const chunk of createReadStream(file))h.update(chunk);return h.digest('hex');}
export async function sourceDigest(root){
  const rows=[];
  async function walk(dir){for(const item of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
    if(['node_modules','.git','__pycache__'].includes(item.name))continue;
    const file=path.join(dir,item.name);
    if(item.isDirectory())await walk(file);else if(item.isFile()&&/\.(mjs|cjs|js|py|json|ts)$/.test(item.name))rows.push([path.relative(root,file),await digest(file)]);
  }}
  await walk(root);return hash(rows);
}
export async function fingerprint(adapter,inspection){
  const protocol=PROTOCOLS[adapter.kind];if(!protocol)throw Error('AGENT_PROTOCOL_NOT_REGISTERED');
  const configuration=adapter.configuration??{},files=[];
  const candidates=new Set([configuration.executable,configuration.node,configuration.python,configuration.entrypoint?.split(':')[0],
    ...(inspection.installRoot?.endsWith('.app')?[path.join(inspection.installRoot,'Contents/Info.plist'),path.join(inspection.installRoot,'Contents/Resources/app.asar')]:[]),
    ...[configuration.packageRoot,configuration.sourceRoot].filter(Boolean).flatMap(root=>['package.json','pnpm-lock.yaml','uv.lock','poetry.lock','requirements.txt'].map(f=>path.join(root,f))),
    ...(configuration.extensionCatalog??[]).filter(x=>(configuration.extensions??[]).includes(x.name)).map(x=>path.join(x.path,'package.json'))].filter(Boolean));
  for(const file of [...candidates].sort()){
    try{const resolved=await realpath(file),stat=await lstat(resolved);if(stat.isFile())files.push([file,resolved,await digest(resolved)]);}
    catch(e){if(e.code!=='ENOENT')throw e;files.push([file,'MISSING']);}
  }
  const runtimeSources=[];
  for(const dir of [configuration.sourceRoot&&path.join(configuration.sourceRoot,'src'),configuration.packageRoot&&path.join(configuration.packageRoot,'dist'),...(configuration.extensionCatalog??[]).map(x=>x.path)].filter(Boolean)){
    try{runtimeSources.push([dir,await sourceDigest(dir)]);}catch(e){if(e.code!=='ENOENT')throw e;runtimeSources.push([dir,'MISSING']);}
  }
  const dependencies=configuration.python?hash((await promisify(execFile)(configuration.python,['-c','import importlib.metadata,json; print(json.dumps(sorted((d.metadata["Name"],d.version) for d in importlib.metadata.distributions())))'],{timeout:15000,maxBuffer:1048576})).stdout):null;
  const identity={runtimeIdentity:inspection.runtimeIdentity??null,runtimeSources,dependencies,runtimeConfiguration:inspection.configuration??null,targetId:adapter.targetId,kind:adapter.kind,protocol,version:inspection.version??null,build:inspection.build??null,bundle:inspection.bundle??null,
    platform:os.platform(),arch:os.arch(),osRelease:os.release(),node:process.version,configuration:hash(configuration),components:inspection.components??[],files,
    driver:await sourceDigest(path.dirname(here)),nativeDriver:adapter.kind.startsWith('dsh-')?await sourceDigest(path.resolve(here,'../../dist/src')):null,suite:SUITE_VERSION};
  return {digest:hash(identity),identity};
}
