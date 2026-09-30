/** Match only exact, recorded tool declarations. Never infer ownership from names or arguments. */
export function toolAttribution(name: string, declarations: readonly unknown[] = []): {
  kind: string; plugins: string[]; basis: string; evidence: unknown[];
} {
  const object = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string,unknown> : {};
  const matches = declarations.map(object).filter(t=>t.name === name).map(t=>object(t.attribution));
  const known = matches.filter(a=>["TESTED_PLUGIN","BASELINE","AMBIGUOUS"].includes(String(a.kind)) && a.basis === "STATIC_REGISTRATION" && Array.isArray(a.plugins) && a.plugins.length > 0);
  const plugins = [...new Set(known.flatMap(a=>(a.plugins as unknown[]).filter((v):v is string=>typeof v === "string")))].sort();
  const kinds = new Set(known.map(a=>String(a.kind)));
  const kind = kinds.size === 1 && (plugins.length === 1 || kinds.has("BASELINE")) ? String(known[0]!.kind) : plugins.length ? "AMBIGUOUS" : "UNKNOWN";
  return {kind,plugins,basis:known.length ? "STATIC_REGISTRATION" : "NOT_RECORDED",evidence:known.flatMap(a=>Array.isArray(a.evidence)?a.evidence:[])};
}

export function renderToolAttribution(attribution: ReturnType<typeof toolAttribution>): string {
  const e = (v: unknown) => String(v ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#39;");
  const label = attribution.kind === "TESTED_PLUGIN" ? "被测插件" : attribution.kind === "BASELINE" ? "DSH 基础工具" : attribution.kind === "AMBIGUOUS" ? "多来源 · 归属待确认" : "归属未记录";
  const style = attribution.kind === "TESTED_PLUGIN" ? "background:#e8f3ed;color:#176b46;border-left:3px solid #176b46" : "background:#f2f4f6;color:#647080";
  const badge = '<span style="display:inline-block;padding:3px 7px;margin:4px 0;'+style+'">'+e(label)+'</span>';
  if (!attribution.plugins.length) return badge;
  return '<details class="plugin-attribution"><summary>'+badge+' '+e(attribution.plugins.join(" · "))+'</summary><p>按本次冻结的工具注册声明匹配；不证明插件引发了其他工具或环境变化。</p><pre>'+e(JSON.stringify(attribution.evidence,null,2))+'</pre></details>';
}
