/** External report data reader. Keeps evidence out of HTML without changing report CSS/layout. */
import { toolAttribution, renderToolAttribution } from "./tool-attribution.js";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { previewJson } from "./html-preview.js";
import { projectTraceOverview, renderTraceOverview } from "./trace-overview.js";

export function reportLoaderSource(): string {
  return `"use strict";
const toolAttribution = ${toolAttribution.toString()};
const renderToolAttribution = ${renderToolAttribution.toString()};
const previewJson = ${previewJson.toString()};
const projectTraceOverview = ${projectTraceOverview.toString()};
const renderTraceOverview = ${renderTraceOverview.toString()};
let tracePromise;
const loadedFiles = new Map();
async function sha(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), b=>b.toString(16).padStart(2,"0")).join("");
}
async function fetchBytes(relative) {
  if (!/^(all-trace\\/(manifest\\.json|events\\.jsonl|blobs\\/[a-f0-9]{64})|output\\/.+)$/.test(relative) ||
      relative.split("/").some(p=>p===".." || p==="." || !p) || relative.includes("\\\\")) throw new Error("Invalid evidence path");
  const response=await fetch(new URL(relative,document.baseURI),{cache:"no-store"});
  if(!response.ok) throw new Error("Evidence read failed: "+response.status);
  return new Uint8Array(await response.arrayBuffer());
}
async function loadTrace() {
  const marker=document.querySelector("script[data-trace-manifest-sha]");
  const bytes=await fetchBytes("all-trace/manifest.json");
  if(await sha(bytes)!==marker.dataset.traceManifestSha) throw new Error("Evidence manifest digest mismatch");
  const manifest=JSON.parse(new TextDecoder().decode(bytes));
  const index=new Map(manifest.files.map(file=>[file.path,file]));
  const cache=new Map();
  async function file(ref) {
    const expected=index.get(ref.path);
    if(!expected || expected.sha256!==ref.sha256 || expected.byteLength!==ref.byteLength) throw new Error("Unlisted evidence file");
    if(!loadedFiles.has(ref.path)) loadedFiles.set(ref.path,(async()=>{
      const bytes=await fetchBytes(ref.path);
      if(bytes.length!==ref.byteLength || await sha(bytes)!==ref.sha256) throw new Error("Evidence digest mismatch");
      return bytes;
    })());
    return loadedFiles.get(ref.path);
  }
  async function node(n,active=new Set()) {
    if(n[0]==="v")return n[1];
    if(n[0]==="a"){const out=[];for(const x of n[1])out.push(await node(x,active));return out;}
    if(n[0]==="o"){const out=Object.create(null);for(const [k,v]of n[1])out[k]=await node(v,active);return out;}
    if(n[0]!=="r")throw new Error("Unknown evidence node");
    const ref=n[1],key=ref.path+":"+ref.encoding;
    if(active.has(key))throw new Error("Cyclic evidence reference");
    if(cache.has(key))return cache.get(key);
    const pending=(async()=>{
      const bytes=await file(ref),text=new TextDecoder().decode(bytes);
      if(ref.encoding==="node")return node(JSON.parse(text),new Set([...active,key]));
      if(ref.encoding==="TEXT")return text;
      if(ref.encoding==="JSON")return JSON.parse(text);
      if(ref.encoding==="BASE64"){let s="";for(let i=0;i<bytes.length;i+=8192)s+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(s);}
      throw new Error("Unknown evidence encoding");
    })();
    cache.set(key,pending);return pending;
  }
  const header=await node(manifest.header);
  const text=new TextDecoder().decode(await file(manifest.events));
  const entries=[];
  for(const line of text.trimEnd().split("\\n")){if(line)entries.push(await node(JSON.parse(line).value));}
  if(entries.length!==manifest.entryCount)throw new Error("Evidence entry count mismatch");
  return {...header,entries};
}
const overview = document.querySelector("[data-trace-overview]");
if(overview) {
  tracePromise ??= loadTrace();
  tracePromise.then(trace => { overview.innerHTML = renderTraceOverview(trace,JSON.parse(overview.dataset.toolDeclarations || "[]")); overview.dataset.loaded = "true"; })
    .catch(error => { overview.textContent = "Trace 读取失败：" + error.message + (location.protocol === "file:" ? "。请通过本地 HTTP 报告服务打开此页面。" : ""); });
}
document.addEventListener("toggle",async event=>{
  const details=event.target;
  if(!(details instanceof HTMLDetailsElement) || !details.open || !details.dataset.traceSelect || details.dataset.loaded)return;
  const pre=details.querySelector("pre");
  try {
    pre.textContent="正在读取证据…";
    tracePromise ??= loadTrace();
    const trace=await tracePromise;
    const select=JSON.parse(details.dataset.traceSelect);
    let value=select.kind==="integrity"?{sources:trace.sources,integrity:trace.integrity}:trace[select.kind];
    if(select.ids)value=trace.entries.filter(entry=>select.ids.includes(entry.id));
    if(select.layer && Array.isArray(value))value=value.filter(entry=>entry.layer===select.layer);
    const preview=previewJson(value);pre.textContent=preview.text;
    if(preview.truncated)pre.textContent+="\\n（页面预览已限制；完整证据保存在 all-trace 目录。）";
    details.dataset.loaded="true";
  } catch(error) {pre.textContent="证据读取失败："+error.message+(location.protocol==="file:"?"。请通过本地 HTTP 报告服务打开此页面。":"");}
},true);
`;
}
export async function writeReportLoader(directory: string): Promise<void> {
  await writeFile(path.join(directory, "report-data.js"), reportLoaderSource(), {flag:"wx",mode:0o400});
}
