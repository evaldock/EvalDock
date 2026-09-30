/** Display only: the original report layout over the current immutable result record. */
import type { EvaluationResult, ResultData } from "./types.js";
import { previewJson } from "./html-preview.js";
import { reportStyle } from "./report-style.js";
import { toolAttribution, renderToolAttribution } from "./tool-attribution.js";
import { renderTraceOverview } from "./trace-overview.js";

const e = (value: unknown) => String(value ?? "—").replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string => Array.isArray(value) ? value.map(text).join(", ") :
  value !== null && typeof value === "object" ? JSON.stringify(value) : String(value ?? "—");
const table = (rows: readonly (readonly [string, unknown])[]) =>
  '<table class="record-table"><tbody>' + rows.map(([key, value]) =>
    "<tr><th>" + e(key) + "</th><td>" + e(text(value)) + "</td></tr>").join("") + "</tbody></table>";
const json = (value: unknown) => {
  const preview = previewJson(value);
  return (preview.truncated ? '<p class="note">Preview limited · 页面预览已限制，完整内容保留在原记录中。</p>' : "") +
    "<pre>" + e(preview.text) + "</pre>";
};
const detail = (title: string, value: unknown) => "<details><summary>" + e(title) + "</summary>" + json(value) + "</details>";
const raw = (value: string | undefined) => value === undefined ? '<p class="empty">未记录</p>' :
  '<pre class="raw-output">' + e(value.slice(0, 32000)) + "</pre>" +
  (value.length > 32000 ? '<p class="note">Preview limited · 完整文本见 report.json。</p>' : "");

export function renderReportHtml(data: EvaluationResult | ResultData): string {
  const inspection = data.inspection;
  const target = object(data.target);
  const externalAgent = typeof target.agentKind === "string" && target.agentKind !== "dsh";
  const agentName = String(target.agentName ?? ({workbuddy:"WorkBuddy",pi:"Pi",langgraph:"LangGraph"} as Record<string,string>)[String(target.agentKind)] ?? "DSH");
  const plan = data.plan?.casePlan;
  const execution = data.execution;
  const labelTitle = (id: string) => data.labels.find(label => label.labelId === id)?.title ?? id;
  const traceDetail = (title: string, kind: string, ids?: readonly string[], layer?: string) =>
    '<details data-trace-select="' + e(JSON.stringify({ kind, ...(ids ? { ids } : {}), ...(layer ? { layer } : {}) })) +
    '"><summary>' + e(title) + '</summary><pre>展开读取证据</pre></details>';
  const evidenceDetail = (title: string, kind: "entries" | "coverage" | "integrity", layer?: string) =>
    data.allTraceRef ? traceDetail(title, kind, undefined, layer) :
      detail(title, kind === "integrity" ? { sources: data.allTrace?.sources, integrity: data.allTrace?.integrity } :
        kind === "entries" && layer ? data.allTrace?.entries.filter(entry => entry.layer === layer) : data.allTrace?.[kind]);
  const scored = data.scores.filter(score => score.status === "SCORED").length;
  const errors = data.scores.filter(score => score.status === "ERROR").length;
  const unassessable = data.scores.filter(score => score.status === "UNASSESSABLE").length;
  const dimensions = data.dimensions.map(item => {
    const width = item.score === null || item.max <= item.min ? 0 :
      Math.max(0, Math.min(100, 100 * (item.score - item.min) / (item.max - item.min)));
    return '<div class="dimension"><strong>' + e(labelTitle(item.labelId)) + "</strong><span>" +
      e(item.score === null ? "未评分" : item.score.toFixed(2) + " / " + item.max) +
      '</span><div class="track"><i style="width:' + width + '%"></i></div><small>已评分 ' + item.scoredCases +
      " · 无法判断 " + item.unassessableCases + " · Judge 错误 " + item.errorCases + "</small></div>";
  }).join("");
  const plugins = (inspection?.pluginCatalog ?? []).map(value => {
    const plugin = object(value);
    return "<tr><td><code>" + e(plugin.packageName ?? plugin.id) + "</code></td><td>" +
      e(plugin.version) + "</td><td>" + e(plugin.role) + "</td><td>" + e(plugin.description) + "</td></tr>";
  }).join("");
  const declarations = inspection?.toolSchemas ?? [];
  const toolNames = [...new Set(declarations.map(value=>object(value).name).filter((name): name is string=>typeof name === "string" && name !== "UNKNOWN"))];
  const toolOrigins = toolNames.map(name=>"<tr><td>"+e(name)+"</td><td>"+renderToolAttribution(toolAttribution(name,declarations))+"</td></tr>").join("");
  const labelIds = plan?.labelIds ?? data.scores.map(score => score.labelId);
  const labels = labelIds.map(id => "<tr><td>" + e(labelTitle(id)) + "</td><td><code>" + e(id) +
    "</code></td><td>本 Case 覆盖的标签</td></tr>").join("");
  const outputPaths = data.allTraceRef ? data.allTraceRef.outputs : (data.allTrace?.entries ?? []).flatMap(entry => {
    const file = object(entry.content);
    return entry.layer === "DELIVERY" && typeof file.portablePath === "string" &&
      file.portablePath.startsWith("output/") && !file.contentRestricted ? [file.portablePath] : [];
  });
  const outputs = [...new Set(outputPaths)].map(file => "<tr><td><a href=\"" +
    e(file.split("/").map(encodeURIComponent).join("/")) + "\">" + e(file) +
    "</a></td><td>已归档；内容及评价范围见交付证据</td></tr>").join("");
  const scores = data.scores.map(score => '<article class="judge-record ' +
    (score.status === "SCORED" ? "scored" : score.status === "ERROR" ? "error" : "unevaluable") +
    '"><header><div><small>' + e(score.labelId) + "</small><h3>" + e(labelTitle(score.labelId)) +
    "</h3></div><strong>" + e(score.score === null ? score.status : score.score.toFixed(2) + " / " + score.scale.max) +
    "</strong></header>" + table([
      ["状态", score.status], ["评分模型", score.model], ["评分时间", score.createdAt],
      ["引用证据", score.evidenceIds.length + " 条"], ["评分输入", "本 Case 的同一份完整 all trace"],
      ["响应处理记录", score.warnings?.join(", ") || "—"],
    ]) + '<h3>评分理由</h3><p class="judge-reason">' + e(score.reason) + "</p>" +
    '<div class="evidence-list">' + (data.allTraceRef ?
      traceDetail("引用的真实证据（" + score.evidenceIds.length + "）", "entries", score.evidenceIds) :
      detail("引用的真实证据", data.allTrace?.entries.filter(entry => score.evidenceIds.includes(entry.id)) ?? [])) +
    detail("完整评分记录", score) + "</div></article>").join("");
  const summary = [
    ["Run", data.runId], ["Target", data.target.targetId], ["State / Phase", data.runState + " / " + data.currentPhase],
    ["Health", data.operationalHealth], ["Isolation", data.securityIsolation],
    ["标签评分", scored + " 已评分 / " + unassessable + " 无法判断 / " + errors + " 错误"],
    ["Started / Ended", (execution?.startedAt ?? "—") + " / " + (execution?.endedAt ?? "—")],
    ["Environment", data.environmentState],
  ].map(([key, value]) => "<dt>" + e(key) + "</dt><dd>" + e(value) + "</dd>").join("");
  const timeline = data.timeline.map(step => "<tr><td>" + step.number + "</td><td>" + e(step.label) +
    "</td><td>" + e(step.status) + "</td><td>" + e(step.startedAt) + "</td><td>" + e(step.endedAt) +
    "</td><td>" + e(step.hintCode ?? step.failureGroups.join(", ")) + "</td></tr>").join("");

  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>EvalDock / ' +
    e(data.runId) + "</title><style>" + reportStyle + '</style></head><body class="evaldock-v3">' +
    '<header class="topbar"><strong>EvalDock / 原始评测记录</strong><nav><a href="#input">输入与计划</a><a href="#output">Agent 输出</a><a href="#trace">Trace</a><a href="#judges">标签评分</a><a href="#files">文件环境</a><a href="#audit">审计索引</a></nav><span>' +
    e("schema" in data ? "RECORDED" : data.runState) + '</span></header><main id="top">' +
    '<section class="run-summary"><div><small>标签评分进度</small><strong>' + scored + " / " + data.scores.length +
    '</strong><span>已评分' + (data.fixture ? " · FIXTURE" : "") + '</span></div><dl>' + summary + "</dl></section>" +
    '<section id="input"><h2>1. 输入与 Planner 的真实记录</h2><div class="split"><div><h3>Agent 收到的任务原文</h3>' +
    raw(execution?.task) + '</div><div><h3>静态检查</h3>' + table([
      [externalAgent ? agentName + " version" : "DSH version", externalAgent ? target.agentVersion : object(inspection?.dshVersionStatus).version ?? data.target.dshPackageVersion],
      ["Profile", externalAgent ? target.agentKind : data.target.profile], ["实际执行入口", externalAgent ? target.installRoot : data.target.dshExecutablePath],
      ["Probe", inspection ? inspection.probeSchema + " · configured: " + inspection.probeConfigured : "未记录"],
      ["Driver", inspection?.headlessDriverStatus],
      ["Tools", inspection?.toolSchemas.map(value => { const tool = object(value); return tool.name ?? tool.implementation ?? tool.status; })],
      ["Permission", inspection?.permissionPreset], ["Sandbox", inspection?.sandboxMode],
      ["Limitations", inspection?.limitations.length],
    ]) + "</div></div>" + (externalAgent ? "" : "<h3>被测 DSH 包含的插件</h3><table><thead><tr><th>插件</th><th>版本</th><th>角色</th><th>说明</th></tr></thead><tbody>" +
    (plugins || '<tr><td colspan="4">静态记录中未提供插件列表</td></tr>') + "</tbody></table>") +
    '<h3>工具来源</h3><table><thead><tr><th>工具</th><th>来源</th></tr></thead><tbody>'+toolOrigins+'</tbody></table>'+
    '<h3>标签来源</h3><table><thead><tr><th>标签</th><th>ID</th><th>来源</th></tr></thead><tbody>' + labels +
    "</tbody></table><h3>Planner 输出</h3>" + table([
      ["selectedLabelIds", labelIds], ["datasetId", plan?.datasetId], ["scenarioId", plan?.scenarioId],
      ["environmentId", plan?.environmentId], ["deadline", plan ? plan.deadlineMs + " ms" : undefined],
      ["allowed / forbidden", plan ? plan.allowedPaths.join(", ") + " / " + plan.forbiddenPaths.join(", ") : undefined],
      ["status", data.plan?.status],
    ]) + detail("静态检查完整记录", inspection ?? data.target) + detail("完整执行计划", data.plan) +
    detail("Case 及题目评分参考", data.case) + detail("本次冻结的标签标准", data.labels) + "</section>" +
    '<section id="output"><h2>2. Agent 的真实执行结果</h2>' + table([
      ["terminationKind", execution?.terminationKind], ["exitCode / signal", text(execution?.exitCode) + " / " + text(execution?.signal)],
      ["pid", execution?.pid], ["duration", execution?.durationMs === undefined ? undefined : execution.durationMs + " ms"],
      ["startedAt / endedAt", text(execution?.startedAt) + " / " + text(execution?.endedAt)],
      ["Agent Session", object(execution).agentSessionIds ?? execution?.dshSessionIds],
    ]) + "<h3>stdout / 最终回复 <small>" + e(execution?.stdoutCapturedBytes) + " bytes · captureTruncated: " +
    e(execution?.stdoutCaptureTruncated) + " · reportTruncated: " + e(execution?.stdoutReportTruncated) +
    "</small></h3>" + raw(execution?.stdout) + "<h3>stderr <small>" + e(execution?.stderrCapturedBytes) +
    " bytes · captureTruncated: " + e(execution?.stderrCaptureTruncated) + " · reportTruncated: " + e(execution?.stderrReportTruncated) +
    "</small></h3>" + raw(execution?.stderr) + detail("输入交付记录", execution?.inputDelivery) + "</section>" +
    '<section id="trace"><h2>3. Trace 中实际观察到的数据</h2>' +
    (data.allTraceRef ? '<div data-trace-overview data-tool-declarations="'+e(JSON.stringify(declarations.map(value=>{const t=object(value);return {name:t.name,attribution:t.attribution};})))+'"><p role="status">正在读取 Trace 统计与工具调用…</p></div>' :
      data.allTrace ? renderTraceOverview(data.allTrace,declarations) : '<p class="empty">尚未生成 Trace</p>') +
    evidenceDetail("Agent 的执行记录", "entries", "AGENT") +
    evidenceDetail("采集覆盖状态", "coverage") + evidenceDetail("来源和完整性记录", "integrity") +
    evidenceDetail("全部证据实际内容", "entries") + "</section>" +
    '<section id="judges"><h2>4. 逐标签评分的真实记录</h2>' + (dimensions || '<p class="empty">尚未形成维度评分</p>') +
    (scores || '<p class="empty">尚未生成 Judge 记录</p>') + "</section>" +
    '<section id="files"><h2>5. 交付文件与环境变化</h2><h3>交付文件</h3><table><thead><tr><th>文件</th><th>记录状态</th></tr></thead><tbody>' +
    (outputs || '<tr><td colspan="2">没有已归档的交付文件</td></tr>') + "</tbody></table>" +
    evidenceDetail("交付证据与内容读取范围", "entries", "DELIVERY") + "<h3>Observer 最终环境变化</h3>" +
    evidenceDetail("环境组件变化的真实记录", "entries", "ENVIRONMENT") + detail("环境收尾", data.reset) + "</section>" +
    '<section id="audit"><h2>6. 流程与审计索引</h2><table><thead><tr><th>#</th><th>步骤</th><th>状态</th><th>开始</th><th>结束</th><th>异常提示</th></tr></thead><tbody>' +
    timeline + "</tbody></table>" + detail("运行异常", data.failures) + detail("附件索引", data.artifacts) +
    detail("All trace 索引", data.allTraceRef) +
    '<p><a href="report.json">统一结果记录 · report.json</a>' +
    (data.allTraceRef ? ' · <a href="all-trace/manifest.json">All trace manifest</a>' : "") +
    "</p></section></main><footer>EvalDock · " + e(data.runId) + "</footer>" +
    (data.allTraceRef ? '<script defer src="report-data.js" data-trace-manifest-sha="' + e(data.allTraceRef.manifestDigest.value) + '"></script>' : "") +
    "</body></html>";
}
export const renderStatusHtml = renderReportHtml;
