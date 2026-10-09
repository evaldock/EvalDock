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
  {kind:'pi',name:'Pi',commands:['pi'],packages:['@mariozechner/pi-coding-agent']},
  {kind:'openclaw',name:'OpenClaw',commands:['openclaw'],packages:['openclaw']},
  {kind:'hermes',name:'Hermes',commands:['hermes'],apps:['Hermes.app']},
  {kind:'workbuddy',name:'WorkBuddy',apps:['WorkBuddy.app']},
  {kind:'qwenwork',name:'千问办公',apps:['QwenWorkCN.app'],bundle:'cn.qwenwork.desktop.mac'},
  {kind:'doubaowork',name:'豆包办公',apps:['DoubaoWork.app'],bundle:'com.work.pc.doubao'},
  {kind:'codex',name:'Codex',commands:['codex'],apps:['Codex.app'],packages:['@openai/codex'],unsupported:true},
  {kind:'claude',name:'Claude Code / Claude',commands:['claude'],apps:['Claude.app'],packages:['@anthropic-ai/claude-code'],unsupported:true},
];
const exists=async file=>access(file).then(()=>true,()=>false);
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
        if(def.kind==='openclaw'&&await exists(path.join(path.dirname(location),'node')))item.target={id:'local-openclaw',kind:def.kind,name:def.name,sourceRoot:pkg.root,node:path.join(path.dirname(location),'node'),executable:canonical,model:'deepseek-v4-flash'};
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
