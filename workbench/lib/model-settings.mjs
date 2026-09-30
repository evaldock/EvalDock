import {readFile,mkdir,writeFile,rename,unlink} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';
import {parseEnv} from 'node:util';
import {randomUUID} from 'node:crypto';
const roles=['planner','judge'];
const fields={model:'MODEL',endpoint:'MODEL_ENDPOINT',apiKey:'API_KEY'};
const prefix=role=>'EVALDOCK_'+role.toUpperCase()+'_';
const managed=/^EVALDOCK_(PLANNER|JUDGE)_(API_KEY|MODEL|MODEL_ENDPOINT)$/;
const settingError=message=>Object.assign(new Error(message),{statusCode:400});
const defaults={model:'deepseek-flash',endpoint:'https://api.deepseek.com/chat/completions'};
export class ModelSettings {
 constructor({controllers=[],file=path.join(homedir(),'.config/evaldock/models.env')}={}){this.controllers=controllers;this.file=file;this.saving=false;}
 async read(){try{return await readFile(this.file,'utf8');}catch(e){if(e.code==='ENOENT')return '';throw e;}}
 environment(){return this.controllers.find(c=>c.env)?.env??this.controllers.find(c=>c.jobs?.environment)?.jobs.environment??process.env;}
 resolve(raw){const env=this.environment(),saved=parseEnv(raw);return Object.fromEntries(roles.map(role=>[role,Object.fromEntries(Object.entries(fields).map(([field,suffix])=>[field,saved[prefix(role)+suffix]??env[prefix(role)+suffix]??(field==='apiKey'?env.DEEPSEEK_API_KEY??'':defaults[field])]))]));}
 public(values){return Object.fromEntries(roles.map(role=>[role,{model:values[role].model,endpoint:values[role].endpoint,keyConfigured:!!values[role].apiKey}]));}
 async get(){return this.public(this.resolve(await this.read()));}
 apply(values){
  for(const c of this.controllers){
   const environments=new Set([c.env,c.jobs?.environment].filter(Boolean));
   for(const env of environments)Object.assign(env,values);
   if(c.jobs)c.jobs.secrets=[...new Set([...(c.jobs.secrets??[]),...Object.entries(values).filter(([k])=>k.endsWith('_API_KEY')).map(([,v])=>v)])].filter(Boolean);
   c.cacheUntil=0;
  }
 }
 async init(){const values=Object.fromEntries(Object.entries(parseEnv(await this.read())).filter(([k])=>managed.test(k)));this.apply(values);}
 validate(role,input){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!Object.hasOwn(fields,k)))throw settingError('模型配置字段无效');
  const result={};
  for(const [field,value] of Object.entries(input)){
   if(typeof value!=='string')throw settingError('模型配置必须为文本');
   const text=value.trim();if(field==='apiKey'&&!text)continue;
   if(!text||text.length>(field==='apiKey'?4096:field==='endpoint'?2048:200)||/[\r\n\0'"\\]/.test(text))throw settingError('请检查 '+role+' 的配置格式');
   if(field==='apiKey'&&/\s/.test(text))throw settingError('API Key 不能包含空格');
   if(field==='endpoint'){
    let url;try{url=new URL(text);}catch{throw settingError('请输入完整的模型接口地址');}
    if(url.username||url.password||url.search||url.hash||!['https:','http:'].includes(url.protocol))throw settingError('接口地址不能包含凭据、查询参数或片段');
    if(url.protocol==='http:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw settingError('远程模型接口请使用 HTTPS');
   }
   result[field]=text;
  }
  return result;
 }
 async save(input){
  if(this.saving)throw Object.assign(new Error('配置正在保存，请稍后重试'),{statusCode:409});
  this.saving=true;
  try{
   if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['planner','judge','reusePlannerForJudge'].includes(k))||input.reusePlannerForJudge!==undefined&&typeof input.reusePlannerForJudge!=='boolean')throw settingError('配置参数无效');
   const raw=await this.read(),values=this.resolve(raw);
   for(const role of roles)if(input[role]!==undefined)Object.assign(values[role],this.validate(role,input[role]));
   if(input.reusePlannerForJudge)values.judge={...values.planner};
   for(const role of roles){this.validate(role,values[role]);if(!values[role].apiKey)throw settingError('请填写 '+(role==='planner'?'Planner':'Judge')+' 的 API Key');}
   const updates=Object.fromEntries(roles.flatMap(role=>Object.entries(fields).map(([field,suffix])=>[prefix(role)+suffix,values[role][field]])));
   // Preserve unrelated settings (timeouts/retries) without reserializing their values.
   const kept=raw.split(/\r?\n/).filter(line=>!/^\s*(?:export\s+)?EVALDOCK_(PLANNER|JUDGE)_(API_KEY|MODEL|MODEL_ENDPOINT)\s*=/.test(line));
   const text=kept.join('\n').replace(/\n*$/,'')+'\n'+Object.entries(updates).map(([k,v])=>k+"='"+v+"'").join('\n')+'\n';
   await mkdir(path.dirname(this.file),{recursive:true,mode:0o700});
   const temp=this.file+'.'+randomUUID()+'.tmp';
   try{await writeFile(temp,text,{mode:0o600,flag:'wx'});await rename(temp,this.file);}finally{await unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});}
   this.apply(updates);return this.public(values);
  }finally{this.saving=false;}
 }
}
