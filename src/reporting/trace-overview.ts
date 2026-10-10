import { toolAttribution, renderToolAttribution } from "./tool-attribution.js";
import type { AllTrace } from "../all-trace/types.js";
import { previewJson } from "./html-preview.js";

export interface TraceToolRow {
  session: string; callId: string; name: string; at: string;
  arguments: unknown; result: unknown; status: string;
}
export interface TraceOverview {
  events: number; sessions: string[]; models: string[]; providers: string[];
  usage: Record<string, number | null>; tools: TraceToolRow[]; types: Record<string, number>;
}

/** Read-only projection. Session + call ID identifies a call; only final message usage is summed. */
export function projectTraceOverview(trace: Pick<AllTrace, "entries">): TraceOverview {
  const obj = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
  const arr = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
  const str = (v: unknown): string => typeof v === "string" ? v : "";
  const sessions = new Set<string>(), models = new Set<string>(), providers = new Set<string>();
  const types: Record<string, number> = Object.create(null) as Record<string, number>;
  const usage: Record<string, number | null> = { input: null, output: null, reasoning: null, cacheRead: null };
  const calls = new Map<string, TraceToolRow>(), usageSeen = new Set<string>();
  const entries = trace.entries.filter(entry => entry.layer === "AGENT");
  const events = entries.map(entry => {
    const content = obj(entry.content), data = obj(content.data), native = obj(data.native);
    const event = obj(data.event);
    const payload = Object.keys(event).length ? obj(event.data) : obj(data.payload ?? data);
    const session = str(data.sessionId ?? obj(native.correlation).sessionId ?? payload.sessionId);
    const kind = str(event.type ?? data.eventName ?? content.kind) || "UNKNOWN";
    if(session) sessions.add(session);
    for(const id of arr(data.sessionIds)) if(typeof id === "string") sessions.add(id);
    types[kind] = (types[kind] ?? 0) + 1;
    return { entry, content, data, event, payload, session, kind };
  });
  // Resolve semantic references only inside their original Session. Ambiguous sequences stay as references.
  const seqIndex = new Map<string, Record<string, unknown> | null>();
  for(const item of events) if(typeof item.event.seq === "number") {
    const key = JSON.stringify([item.session, item.event.seq]);
    if(seqIndex.has(key)) seqIndex.set(key, null); else seqIndex.set(key, item.event);
  }
  const resolve = (value: unknown, session: string, active = new Set<string>()): unknown => {
    const ref = obj(obj(value).evidenceRef);
    if(typeof ref.seq !== "number" || typeof ref.path !== "string" || !ref.path.startsWith("/")) return value;
    const key = JSON.stringify([session, ref.seq]);
    if(active.size >= 8 || active.has(key)) return value;
    let resolved: unknown = seqIndex.get(key);
    if(!resolved) return value;
    for(const segment of ref.path.slice(1).split("/")) {
      const part = segment.replaceAll("~1", "/").replaceAll("~0", "~");
      if(resolved === null || typeof resolved !== "object" || !Object.hasOwn(resolved, part)) return value;
      resolved = (resolved as Record<string, unknown>)[part];
    }
    return resolve(resolved, session, new Set([...active,key]));
  };
  const call = (item: typeof events[number], id: string): TraceToolRow => {
    const key = JSON.stringify([item.session || item.entry.sourceId || "", id || item.entry.id]);
    let row = calls.get(key);
    if(!row) {
      row = { session: item.session, callId: id || "未记录", name: "未记录", at: str(item.content.at),
        arguments: undefined, result: undefined, status: "未记录结果" };
      calls.set(key,row);
    }
    return row;
  };
  for(const item of events) {
    const p = item.payload, message = obj(p.message), source = obj(message.source);
    for(const config of [p, obj(obj(p.header).config), source]) {
      if(typeof config.model === "string") models.add(config.model);
      if(typeof config.provider === "string") providers.add(config.provider);
    }
    if(item.kind === "assistant/message") {
      const usageKey = JSON.stringify([item.session || item.entry.sourceId, message.id ?? item.event.seq ?? item.entry.id]);
      if(!usageSeen.has(usageKey)) {
        usageSeen.add(usageKey);
        const u = obj(p.usage);
        for(const [key, field] of [["input","inputTokens"],["output","outputTokens"],["reasoning","reasoningTokens"],["cacheRead","cacheReadTokens"]] as const) {
          const n = u[field];
          if(typeof n === "number" && Number.isFinite(n) && n >= 0) usage[key] = (usage[key] ?? 0) + n;
        }
      }
      for(const block of arr(message.content).map(obj)) if(block.type === "tool-call") {
        const row = call(item,str(block.id ?? block.callId));
        row.name = str(block.name) || row.name;
        if(block.arguments !== undefined) row.arguments = resolve(block.arguments,item.session);
      }
    }
    if(item.kind === "tool/call") {
      const row = call(item,str(p.callId ?? p.id));
      row.at = str(item.content.at) || row.at;
      row.name = str(p.name) || row.name;
      const args = resolve(p.arguments,item.session);
      if(args !== undefined && (!Object.hasOwn(obj(args),"evidenceRef") || row.arguments === undefined)) row.arguments = args;
    }
    if(item.kind === "tool/result" || item.kind === "tool.final-result") {
      const blocks = arr(message.content).map(obj).filter(block=>block.type === "tool-result");
      for(const result of blocks.length ? blocks : [p]) {
        const id = str(result.toolCallId ?? result.callId ?? obj(message.source).callId ?? obj(obj(item.data.native).correlation).callId);
        const row = call(item,id);
        row.name = str(p.name ?? p.toolName) || row.name;
        row.result = resolve(result.content ?? result.result ?? result, item.session);
        row.status = result.isError === true || result.error != null ? "ERROR" : "COMPLETED";
      }
    }
  }
  return { events: entries.length, sessions: [...sessions], models: [...models], providers: [...providers],
    usage, tools: [...calls.values()], types };
}

/** Same escaped table renderer on the server and in report-data.js; no evidence copy is persisted. */
export function renderTraceOverview(trace: Pick<AllTrace, "entries">, declarations: readonly unknown[] = []): string {
  const view = projectTraceOverview(trace);
  const e = (v: unknown) => String(v ?? "未记录").replaceAll("&","&amp;").replaceAll("<","&lt;")
    .replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#39;");
  const body = (v: unknown) => {
    if(v === undefined) return "未记录";
    const value = previewJson(v);
    // Strings from tool calls often already contain JSON. Preserve their exact captured text.
    const text = typeof v === "string" && v.length <= 2000 ? v : value.text;
    return '<code class="trace-value">' + e(text) + '</code>' +
      (value.truncated ? '<small class="note">Preview limited · 完整内容见原始证据</small>' : "");
  };
  const facts = [["事件",view.events],["工具调用",view.tools.length],["被测插件调用",view.tools.filter(t=>toolAttribution(t.name,declarations).kind === "TESTED_PLUGIN").length],["Session",view.sessions.length || "未记录"],
    ["Model",view.models.join(", ") || "未记录"],["Provider",view.providers.join(", ") || "未记录"]]
    .map(([label,value])=>"<span>"+e(label)+"<strong>"+e(value)+"</strong></span>").join("");
  const usage = [["input",view.usage.input],["output",view.usage.output],["reasoning",view.usage.reasoning],["cache read",view.usage.cacheRead]]
    .map(([label,value])=>"<th>"+e(label)+"</th><td>"+e(value)+"</td>").join("");
  const rows = view.tools.map(row=>"<tr><td>"+e(row.at || "未记录")+"</td><td><code>"+e(row.callId)+
    '</code><small class="trace-session">'+e(row.session)+"</small></td><td>"+e(row.name)+renderToolAttribution(toolAttribution(row.name,declarations))+"</td><td>"+body(row.arguments)+
    "</td><td>"+e(row.status)+(row.result === undefined ? "" : "<details><summary>结果内容</summary>"+body(row.result)+"</details>")+"</td></tr>").join("");
  return '<div class="facts">'+facts+"</div><h3>Token usage</h3><table><tbody><tr>"+usage+
    '</tr></tbody></table><h3>工具调用</h3><p class="note">按 Session 与 callId 合并同一次调用；参数引用已关联到原记录。事件数为当前保留的 Agent 记录，Token 仅汇总最终消息的 usage；未记录的值不记为 0。</p>' +
    '<table class="trace-tools"><thead><tr><th>时间</th><th>callId</th><th>工具</th><th>采集到的参数</th><th>结果事件</th></tr></thead><tbody>'+
    (rows || '<tr><td colspan="5">没有采集到可识别的工具调用</td></tr>')+"</tbody></table>" +
    '<details><summary>全部事件类型计数</summary><table><thead><tr><th>事件类型</th><th>数量</th></tr></thead><tbody>'+
    Object.entries(view.types).map(([kind,count])=>"<tr><td><code>"+e(kind)+"</code></td><td>"+count+"</td></tr>").join("")+"</tbody></table></details>";
}
