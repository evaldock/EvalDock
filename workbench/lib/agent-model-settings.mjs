import {readFile,mkdir,writeFile,rename,unlink} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {readAgentModelKey} from '../../adapters/shared/registry.mjs';

const settingError=(message,statusCode=400)=>Object.assign(new Error(message),{statusCode});
export class AgentModelSettings {
 constructor({controllers=[],file=path.join(homedir(),'.config/evaldock/agent-model.env'),legacyFile=path.join(homedir(),'.dsh/.env'),environment=process.env}={}){
  this.controllers=controllers;this.file=file;this.legacyFile=legacyFile;this.environment=environment;this.saving=false;
 }
 async key(){return readAgentModelKey({file:this.file,legacyFile:this.legacyFile,environment:this.environment});}
 async get(){return {provider:'deepseek',keyConfigured:!!await this.key()};}
 apply(key){
  for(const controller of this.controllers){
   controller.cacheUntil=0;controller.preflights?.clear();
   if(controller.jobs)controller.jobs.secrets=[...new Set([...(controller.jobs.secrets??[]),key])].filter(Boolean);
  }
 }
 async init(){const key=await this.key();if(key)this.apply(key);}
 async save(input){
  if(this.saving)throw settingError('配置正在保存，请稍后重试',409);
  if(this.controllers.some(controller=>controller.active))throw settingError('请等待 CLI Agent 的评测结束后修改模型密钥。',409);
  this.saving=true;
  try{
   if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>key!=='apiKey')||typeof input.apiKey!=='string')throw settingError('被测 Agent 的模型配置格式无效');
   const value=input.apiKey.trim();
   if(value.length>4096||/[\s\0'"\\]/.test(value))throw settingError('API Key 不能包含空格、换行或引号');
   const key=value||await this.key();if(!key)throw settingError('请填写被测 Agent 的 DeepSeek API Key');
   if(key.length>4096||/[\s\0'"\\]/.test(key))throw settingError('已有 Agent 密钥格式无效，请重新填写 DeepSeek API Key');
   let raw='';try{raw=await readFile(this.file,'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}
   const kept=raw.split(/\r?\n/).filter(line=>!/^\s*(?:export\s+)?DEEPSEEK_API_KEY\s*=/.test(line));
   const contents=kept.join('\n').replace(/\n*$/,'')+"\nDEEPSEEK_API_KEY='"+key+"'\n";
   await mkdir(path.dirname(this.file),{recursive:true,mode:0o700});
   const temporary=this.file+'.'+randomUUID()+'.tmp';
   try{await writeFile(temporary,contents,{mode:0o600,flag:'wx'});await rename(temporary,this.file);}
   finally{await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
   this.apply(key);return this.get();
  }finally{this.saving=false;}
 }
}
