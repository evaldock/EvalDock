import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);

// Inspect the command surface without submitting a model request.
export async function checkCliInterface({command,args,required,execCommand=exec}){
 let result;
 try{result=await execCommand(command,args,{timeout:12000,maxBuffer:256*1024,env:{...process.env,...(process.versions.electron?{ELECTRON_RUN_AS_NODE:'1'}:{})}});}
 catch{throw Error('AGENT_CLI_INTERFACE_UNAVAILABLE');}
 const output=(result.stdout??'')+'\n'+(result.stderr??'');
 const tokens=new Set(output.match(/--[a-z][a-z0-9-]*/gi)??[]);
 if(required.some(flag=>!tokens.has(flag)))throw Error('AGENT_CLI_INTERFACE_CHANGED');
}
