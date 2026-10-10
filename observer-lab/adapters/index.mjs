import {readdir,readFile} from "node:fs/promises";
const loaded={};
for(const entry of await readdir(new URL("./",import.meta.url),{withFileTypes:true})){
 if(!entry.isDirectory())continue;
 let manifest;
 try{manifest=JSON.parse(await readFile(new URL(entry.name+"/manifest.json",import.meta.url),"utf8"));}
 catch(e){if(e.code==="ENOENT")continue;throw e;}
 if(manifest.enabled)loaded[entry.name]=await import(new URL(entry.name+"/index.mjs",import.meta.url));
}
export const adapters=Object.freeze(loaded);
