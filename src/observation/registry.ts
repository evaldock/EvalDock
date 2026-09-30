import {readdir,readFile,access} from "node:fs/promises";
import path from "node:path";
import {digestValue,validateStableId,type SensorAdapterDescriptor} from "../core/models.js";
export interface ObserverRegistration extends SensorAdapterDescriptor {readonly component:string;readonly enabled:boolean;}
export async function loadObserverRegistry(root:string):Promise<readonly ObserverRegistration[]> {
  const directory=path.join(root,"observer-lab/adapters");
  const result:ObserverRegistration[]=[];
  for(const entry of (await readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
    if(!entry.isDirectory())continue;
    let raw;
    try{raw=JSON.parse(await readFile(path.join(directory,entry.name,"manifest.json"),"utf8"));}
    catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")continue;throw error;}
    if(!/^[a-z][a-z0-9-]*$/.test(entry.name)||typeof raw.sourceType!=="string"||!raw.sourceType||
      typeof raw.implementationVersion!=="string"||typeof raw.enabled!=="boolean"||
      !Array.isArray(raw.capabilities)||raw.capabilities.some((c:unknown)=>typeof c!=="string"))
      throw new Error("Invalid Observer manifest: "+entry.name);
    await access(path.join(directory,entry.name,"index.mjs"));
    const capabilities=Object.freeze([...new Set<string>(raw.capabilities)].sort());
    const descriptor=Object.freeze({component:entry.name,enabled:raw.enabled,sourceType:raw.sourceType,
      implementationId:validateStableId<"SensorImplementationId">(raw.implementationId),
      implementationVersion:raw.implementationVersion,capabilities,capabilityDigest:digestValue(capabilities)});
    if(result.some(r=>r.sourceType===descriptor.sourceType||r.implementationId===descriptor.implementationId))
      throw new Error("Duplicate Observer registration: "+entry.name);
    result.push(descriptor);
  }
  return Object.freeze(result);
}
