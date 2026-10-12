import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);

export const inspectionEnvironment=()=>Object.fromEntries(['PATH','HOME','LANG','TMPDIR','SSL_CERT_FILE','NODE_EXTRA_CA_CERTS'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));

/** Select a known command contract from advertised capabilities, never from a version range. */
export async function selectCliProfile({command,args,profiles,execCommand=exec}){
 let result;
 try{result=await execCommand(command,args,{timeout:15000,maxBuffer:256*1024,env:{...inspectionEnvironment(),...(process.versions.electron?{ELECTRON_RUN_AS_NODE:'1'}:{})}});}
 catch{throw Error('AGENT_CLI_INTERFACE_UNAVAILABLE');}
 const output=(result.stdout??'')+'\n'+(result.stderr??'');
 const flags=[...new Set(output.match(/--[a-z][a-z0-9-]*/gi)??[])].sort();
 const profile=profiles.find(p=>p.required.every(flag=>flags.includes(flag))&&(p.values??[]).every(value=>output.includes(value)));
 if(!profile)throw Error('AGENT_CLI_INTERFACE_CHANGED');
 return {id:profile.id,flags};
}

// Inspect the command surface without submitting a model request.
export async function checkCliInterface({command,args,required,execCommand=exec}){
 return selectCliProfile({command,args,profiles:[{id:'cli-flags/v1',required}],execCommand});
}
