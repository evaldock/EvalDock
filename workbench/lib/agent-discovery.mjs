import {access,readFile,readdir,realpath,stat} from 'node:fs/promises';
import {constants} from 'node:fs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {homedir} from 'node:os';
import {createHash} from 'node:crypto';
import path from 'node:path';
const exec=promisify(execFile);
const definitions=[
  {kind:'dsh',name:'DSH',commands:['dsh'],packages:['@deepseek-ai/dsh']},
  {kind:'pi',name:'Pi',commands:['pi'],packages:['@mariozechner/pi-coding-agent','@earendil-works/pi-coding-agent']},
  {kind:'openclaw',name:'OpenClaw',commands:['openclaw'],packages:['openclaw']},
  {kind:'hermes',name:'Hermes',commands:['hermes'],apps:['Hermes.app']},
  {kind:'workbuddy',name:'WorkBuddy',apps:['WorkBuddy.app']},
  {kind:'qwenwork',name:'千问办公',apps:['QwenWorkCN.app'],bundle:'cn.qwenwork.desktop.mac'},
  {kind:'doubaowork',name:'豆包办公',apps:['DoubaoWork.app'],bundle:'com.work.pc.doubao'},
  {kind:'codex',name:'Codex',commands:['codex'],apps:['Codex.app'],packages:['@openai/codex'],unsupported:true},
  {kind:'claude',name:'Claude Code / Claude',commands:['claude'],apps:['Claude.app'],packages:['@anthropic-ai/claude-code'],unsupported:true},
];
const exists=async file=>access(file).then(()=>true,()=>false);
const executableFile=async file=>{try{await access(file,constants.X_OK);return (await stat(file)).isFile();}catch{return false;}};
const json=async file=>{try{return JSON.parse(await readFile(file,'utf8'));}catch{return null;}};
async function packageAt(file){
  let directory=path.dirname(file);
  for(let i=0;i<8;i++){
    const pkg=await json(path.join(directory,'package.json'));
    if(pkg?.name)return {root:directory,...pkg};
    const parent=path.dirname(directory);if(parent===directory)break;directory=parent;
  }
  return null;
}
export async function readAppInfo(file){return JSON.parse((await exec('/usr/bin/plutil',['-convert','json','-o','-',path.join(file,'Contents/Info.plist')],{timeout:2500,maxBuffer:262144})).stdout);}
/** Read installation metadata only. Never launch discovered commands, source shells or read credentials. */
export async function scanLocalAgents({home=homedir(),pathValue=process.env.PATH??'',appRoots=[ '/Applications',path.join(home,'Applications') ],readInfo=readAppInfo,extraBins=[],systemBins=['/opt/homebrew/bin','/usr/local/bin','/usr/bin']}={}){
  const errors=[],found=new Map();
  const nvm=path.join(home,'.nvm/versions/node');
  let versions=[];try{versions=(await readdir(nvm)).filter(n=>/^v\d/.test(n)).sort().reverse().slice(0,20);}catch(e){if(e.code!=='ENOENT')errors.push('无法读取 NVM 安装目录');}
  const bins=[...new Set([...pathValue.split(path.delimiter),...systemBins,...extraBins,path.join(home,'.local/bin'),path.join(home,'.bun/bin'),path.join(home,'.npm-global/bin'),path.join(home,'.volta/bin'),...versions.map(v=>path.join(nvm,v,'bin')),path.join(home,'Agents/hermes/.venv/bin'),path.join(home,'.hermes/hermes-agent/.venv/bin')].filter(p=>path.isAbsolute(p)))];
  const add=async(def,location,type,metadata={})=>{
    let canonical;try{canonical=await realpath(location);}catch{return;}
    const key=def.kind+':'+canonical;if(found.has(key))return;
    const id=createHash('sha256').update(key).digest('hex').slice(0,20);
    const item={id,kind:def.kind,name:def.name,path:location,resolvedPath:canonical,type,version:metadata.version??null,supported:!def.unsupported,evaluationReady:false,target:null};
    if(type==='app'&&def.bundle&&metadata.bundle===def.bundle&&location===`/Applications/${def.apps[0]}`)item.target={id:'local-'+def.kind,kind:def.kind,name:def.name};
    if(type==='cli'){
      const pkg=await packageAt(canonical);
      if(pkg&&def.packages?.includes(pkg.name)){
        item.version=pkg.version??null;
        if(def.kind==='openclaw'){
          const candidates=metadata.node?[metadata.node]:[path.join(path.dirname(location),'node'),...bins.map(bin=>path.join(bin,'node'))];
          for(const node of candidates)if(await executableFile(node)){item.target={id:'local-openclaw',kind:def.kind,name:def.name,sourceRoot:pkg.root,node,executable:canonical,model:'deepseek-v4-flash'};break;}
        }
        if(def.kind==='pi')item.target={id:'local-pi',kind:def.kind,name:def.name,sourceRoot:pkg.root,packageRoot:pkg.root,executable:canonical,model:'deepseek-flash',extensions:[],extensionCatalog:[]};
      }
      if(def.kind==='hermes')item.target={id:'local-hermes',kind:def.kind,name:def.name,sourceRoot:path.dirname(path.dirname(canonical)),executable:canonical,model:'deepseek-v4-flash'};
    }
    // Installation discovery is distinct from transport, login and execution readiness.
    item.nextStep=def.unsupported?'已识别安装；评测适配器尚未接入':item.target?'可接入评测，接入后检查登录和运行条件':def.kind==='workbuddy'?'已发现应用，正在通过现有适配器检查连接':def.kind==='dsh'?'已识别 DSH，请在高级工作台检查 Web Profile':'已识别安装，仍需补充执行入口或安装路径配置';
    found.set(key,item);
  };
  for(const def of definitions){
    for(const root of appRoots)for(const name of def.apps??[]){
      const location=path.join(root,name);if(!await exists(location))continue;
      try{const info=await readInfo(location);if(!info.CFBundleIdentifier)continue;await add(def,location,'app',{version:info.CFBundleShortVersionString,bundle:info.CFBundleIdentifier});}
      catch{errors.push('无法读取 '+def.name+' 的应用信息');}
    }
    // Bounded, known layouts; inspect metadata without launching code or traversing user projects.
    const localEntries=def.kind==='pi'?[
      {file:path.join(home,'Agents/pi/packages/coding-agent/dist/bundle/cli.js')},
      {file:path.join(home,'Agents/pi/node_modules/@mariozechner/pi-coding-agent/dist/cli.js')},
    ]:def.kind==='openclaw'?[
      {file:path.join(home,'Agents/openclaw/node_modules/openclaw/openclaw.mjs'),node:path.join(home,'Agents/openclaw/runtime/node_modules/node/bin/node')},
    ]:[];
    for(const entry of localEntries){
      try{
        await access(entry.file,constants.R_OK);if(!(await stat(entry.file)).isFile())continue;
        const pkg=await packageAt(await realpath(entry.file));
        if(pkg&&def.packages.includes(pkg.name))await add(def,entry.file,'cli',{node:entry.node});
      }catch{/* Missing or inaccessible local installation. */}
    }
    for(const bin of bins)for(const command of def.commands??[]){
      const location=path.join(bin,command);
      try{await access(location,constants.X_OK);if(!(await stat(location)).isFile())continue;await add(def,location,'cli');}catch{/* Missing or inaccessible candidate is not an installed Agent. */}
    }
  }
  return {scannedAt:new Date().toISOString(),locations:['应用程序目录','PATH 与常见 CLI 安装目录','NVM 与用户级安装目录'],agents:[...found.values()].sort((a,b)=>a.name.localeCompare(b.name)||a.path.localeCompare(b.path)),errors};
}

export class AgentDiscovery {
  constructor(options){this.options=options;this.snapshot=null;this.pending=null;}
  async scan(force=false){
    if(this.pending)return this.pending;
    if(!force&&this.snapshot)return this.snapshot;
    this.pending=scanLocalAgents(this.options).then(value=>(this.snapshot=value)).finally(()=>{this.pending=null;});return this.pending;
  }
}

/** Explicit user configuration: validate files, but leave Graph imports to adapter preflight. */
export async function graphTarget(input,{home=homedir()}={}){
  const fields=['name','sourceRoot','python','entrypoint','model','tools','workspacePaths'];
  if(Object.keys(input).some(k=>!fields.includes(k)))throw Error('未知 Graph 配置字段');
  if(typeof input.name!=='string'||!input.name.trim()||input.name.length>100)throw Error('请填写 Agent 名称（最多 100 字）');
  const expand=value=>{
    if(typeof value!=='string'||value.length>4096||value.includes('\0'))throw Error('请填写有效的本机路径');
    const file=value.startsWith('~/')?path.join(home,value.slice(2)):value;
    if(!path.isAbsolute(file))throw Error('路径需要使用绝对路径或 ~/');return path.normalize(file);
  };
  const sourceRoot=expand(input.sourceRoot),python=expand(input.python);
  const split=typeof input.entrypoint==='string'?input.entrypoint.lastIndexOf(':'):-1;
  if(split<1||!/^[_a-zA-Z][_a-zA-Z0-9]*$/.test(input.entrypoint.slice(split+1)))throw Error('Graph 入口格式为 /路径/入口.py:工厂函数');
  const file=expand(input.entrypoint.slice(0,split)),factory=input.entrypoint.slice(split+1);
  try{
    if(!(await stat(sourceRoot)).isDirectory()||!(await stat(file)).isFile())throw Error();
    await access(file,constants.R_OK);
    if(!await executableFile(python))throw Error();
  }catch{throw Error('请检查项目目录、Python 和 Graph 入口文件是否存在且可访问');}
  const relative=path.relative(await realpath(sourceRoot),await realpath(file));
  if(relative.startsWith('..'+path.sep)||relative==='..'||path.isAbsolute(relative))throw Error('Graph 入口文件必须位于项目目录内');
  if(typeof input.model!=='string'||!input.model.trim()||input.model.length>200)throw Error('请填写模型名称');
  if(!Array.isArray(input.tools)||input.tools.length>100||input.tools.some(t=>typeof t!=='string'||!/^[-a-zA-Z0-9_.]{1,100}$/.test(t)))throw Error('工具名称请使用字母、数字、点、下划线或短横线');
  if(!['host','virtual-root'].includes(input.workspacePaths))throw Error('请选择文件路径模式');
  const entrypoint=file+':'+factory;
  const id='local-graph-'+createHash('sha256').update(python+'\n'+entrypoint).digest('hex').slice(0,20);
  return {id,kind:'langgraph',name:input.name.trim(),sourceRoot,python,entrypoint,model:input.model.trim(),tools:[...new Set(input.tools)],workspacePaths:input.workspacePaths,conversation:{mode:'HISTORY_REPLAY',input:'TASK_TRANSCRIPT'}};
}
