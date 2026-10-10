#!/usr/bin/env node
/** One-time authoring migration. Runtime never provisions environments or shuffles options. */
import { readFile, writeFile, mkdir, readdir, rename, rmdir, lstat } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const canonical = value => Array.isArray(value) ? "["+value.map(canonical).join(",")+"]" :
  value && typeof value === "object" ? "{"+Object.keys(value).sort().map(key=>JSON.stringify(key)+":"+canonical(value[key])).join(",")+"}" : JSON.stringify(value);
export async function migrateCaseInputs(root) {
  let cases=0, moved=0, references=0, options=0;
  const missing=[];
  for (const group of await readdir(root,{withFileTypes:true})) {
    if (!group.isDirectory()) continue;
    for (const entry of await readdir(path.join(root,group.name),{withFileTypes:true})) {
      if (!entry.isDirectory()) continue;
      const dir=path.join(root,group.name,entry.name), file=path.join(dir,"question.json");
      const original=await readFile(file,"utf8").catch(e=>{if(e.code==="ENOENT")return undefined;throw e;});
      if (!original) continue;
      const question=JSON.parse(original), env=question.environment;
      const setup=env.setup;
      if(setup && !["none","copy-public-inputs","self-contained-evaldock-fixture","shuffle-options"].includes(setup.kind))
        throw new Error(file+": migrate unknown Setup explicitly: "+setup.kind);
      const inputs=question.inputs ?? env.inputs ?? [];
      const replacements=new Map();
      for(const input of inputs) {
        if (input.source.startsWith("assets/")) {
          const source=input.source, destination="input/"+source.slice(7);
          const old=path.join(dir,source), next=path.join(dir,destination);
          const info=await lstat(old).catch(e=>{if(e.code==="ENOENT")return undefined;throw e;});
          if(!info) {missing.push(old);replacements.set(source,destination);continue;}
          if(!info.isFile() || info.isSymbolicLink() || source.split("/").includes("..")) throw new Error("Invalid source "+old);
          const bytes=await readFile(old);
          if(input.sha256 && input.sha256!==hash(bytes)) throw new Error("Input digest mismatch: "+old);
          const existing=await readFile(next).catch(e=>{if(e.code==="ENOENT")return undefined;throw e;});
          if(existing && !bytes.equals(existing)) throw new Error("Input migration collision: "+next);
          replacements.set(source,destination);
        }
      }
      // Capture the current deterministic ordering before removing the runtime branch.
      if(setup?.kind==="shuffle-options") {
        const values=setup.options.map((value,index)=>({value,key:hash(canonical({questionId:question.id,index,value}))}))
          .sort((a,b)=>a.key.localeCompare(b.key,"en")).map(x=>x.value);
        const mapping=Object.fromEntries(values.map((v,i)=>[String.fromCharCode(65+i),v]));
        const destination=setup.mappingDestination;
        if(!destination.startsWith("input/") || destination.split("/").includes("..")) throw new Error("Invalid mapping destination");
        const bytes=Buffer.from(JSON.stringify(mapping,null,2)+"\n");
        await mkdir(path.dirname(path.join(dir,destination)),{recursive:true});
        const existing=await readFile(path.join(dir,destination)).catch(e=>{if(e.code==="ENOENT")return undefined;throw e;});
        if(existing && !existing.equals(bytes)) throw new Error("Mapping collision");
        await writeFile(path.join(dir,destination),bytes);
        if(!inputs.some(x=>x.destination===destination)) inputs.push({source:destination,destination,delivery:"workspace",sha256:hash(bytes)});
        const text=values.map((v,i)=>String.fromCharCode(65+i)+". "+v).join("\n");
        question.task.instructions=question.task.instructions.replaceAll("{options}",text);
        const prompt=path.join(dir,"prompt.md");
        const current=await readFile(prompt,"utf8").catch(e=>{if(e.code==="ENOENT")return question.task.instructions;throw e;});
        await writeFile(prompt,current.replaceAll("{options}",text));
        options++;
      }
      for(const input of inputs) {
        input.delivery ??= "workspace";
        if(replacements.has(input.source)) {input.source=replacements.get(input.source);references++;}
      }
      question.inputs=inputs;
      delete env.inputs;delete env.setup;
      if(question.final) {
        // Preserve Case-specific rubric text as Judge context, with no checker dispatch.
        const checks=question.final.checks ?? [];
        question.grading ??= {reference:checks[0]?.reference ?? "private/final.json",
          ...(checks[0]?.output ? {expectedOutputPath:checks[0].output} : {}),
          criteria:checks.map(({kind,hardGate,reference,output,...criteria})=>criteria)};
        delete question.final;
      }
      question.grading ??= {reference:"private/final.json"};
      let serialized=JSON.stringify(question,null,2)+"\n";
      for(const [old,next] of replacements) serialized=serialized.replaceAll(old,next);
      // Stop if a collaborator changed the question after it was read.
      if(await readFile(file,"utf8")!==original) throw new Error("Question changed during migration: "+file);
      for(const [old,next] of replacements) {
        await mkdir(path.dirname(path.join(dir,next)),{recursive:true});
        await rename(path.join(dir,old),path.join(dir,next)).then(()=>moved++).catch(e=>{if(e.code!=="ENOENT")throw e;});
      }
      if(serialized!==original) {await writeFile(file,serialized);cases++;}
      const prompt=path.join(dir,"prompt.md");
      let text=await readFile(prompt,"utf8").catch(e=>{if(e.code==="ENOENT")return question.task.instructions;throw e;});
      for(const [old,next] of replacements) text=text.replaceAll(old,next);
      await writeFile(prompt,text.endsWith("\n")?text:text+"\n");
      await rmdir(path.join(dir,"assets")).catch(e=>{if(!["ENOENT","ENOTEMPTY"].includes(e.code))throw e;});
    }
  }
  return {cases,moved,references,options,missing};
}
if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)
  console.log(JSON.stringify(await migrateCaseInputs(path.resolve(process.argv[2]??"datasets"))));
