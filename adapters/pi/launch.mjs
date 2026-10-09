import path from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';

// The probe and startup check use exactly the same extension list and model configuration.
export async function piLaunch(target,inspection,home,{mode='json',env={}}={}) {
  const agentHome=path.join(home,'.pi/agent'),model=target.model??'deepseek-flash';
  await mkdir(agentHome,{recursive:true,mode:0o700});
  await writeFile(path.join(agentHome,'models.json'),JSON.stringify({providers:{'deepseek-evaldock':{baseUrl:'https://api.deepseek.com',apiKey:'$DEEPSEEK_API_KEY',api:'openai-completions',models:[{id:model,name:model,reasoning:false,input:['text'],contextWindow:1048576,maxTokens:32768,cost:{input:0,output:0,cacheRead:0,cacheWrite:0},compat:{supportsStore:false,supportsDeveloperRole:false,maxTokensField:'max_tokens'}}]}}}),{mode:0o600});
  // Operator-selected permission policy must follow each isolated runtime Home.
  if(target.permissionPreset==='FULL_ACCESS'){
    const policyDir=path.join(agentHome,'extensions/pi-permission-system');
    await mkdir(policyDir,{recursive:true,mode:0o700});
    await writeFile(path.join(policyDir,'config.json'),JSON.stringify({permission:{'*':'allow'},yoloMode:true,permissionReviewLog:true}),{mode:0o600});
  }
  const extensions=inspection.extensions.filter(e=>e.enabled).flatMap(e=>e.entries.map(entry=>path.resolve(e.path,entry)));
  return {command:process.execPath,args:[target.executable,'--mode',mode,...mode==='json'?['--print']:[],'--no-session','--no-extensions','--no-skills','--no-prompt-templates','--no-themes','--no-context-files','--provider','deepseek-evaldock','--model',model,'--thinking','off',...extensions.flatMap(x=>['--extension',x])],env:{...env,HOME:home,PI_CODING_AGENT_DIR:agentHome,PI_OFFLINE:'1'}};
}
