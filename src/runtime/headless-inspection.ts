/** Facts available from an installed Headless profile without a generated effective-config file. */
import {readFile} from "node:fs/promises";
import path from "node:path";
import type {TargetDescriptor,JsonObject} from "../core/models.js";
export async function inspectHeadlessInstallation(d:TargetDescriptor,runtimeFacts?:{permissionPreset:string;sandboxMode:string}):Promise<JsonObject>{
 const pkg=JSON.parse(await readFile(path.join(d.sourceRoot,"package.json"),"utf8"));
 const profile=JSON.parse(await readFile(path.resolve(d.sourceRoot,d.dshHome,"profiles",d.profile,"package.json"),"utf8"));
 const bundles=profile.dsh?.profile?.bundles;
 if(!Array.isArray(bundles)||!bundles.includes("@deepseek-ai/dsh-headless")||bundles.some(x=>typeof x!=="string"))throw Error("DSH_HEADLESS_PROFILE_INVALID");
 return {dshVersion:String(pkg.version??"UNKNOWN"),permissionPreset:runtimeFacts?.permissionPreset??"UNKNOWN",sandboxMode:runtimeFacts?.sandboxMode??"UNKNOWN",
  profile:{plugins:bundles.map((name:string)=>({name}))},
  probe:{configured:false,schema:"dsh-eval.probe/v1",order:"UNKNOWN",captureDispatch:false,captureLogs:false,oneShot:true,sourceRunIdEcho:true,contentModes:["STRUCTURED"]},
  limitations:[{code:"HEADLESS_SESSION_ARCHIVE_CAPTURE",status:"DECLARED",messageRedacted:"Installed profile manifests identify the target; effective permissions are not inferred. Evidence comes from the owned session archive."}]};
}
