import type { BatchWorkflowSummary } from "../app/batch.js";
import { reportStyle } from "./report-style.js";

function e(value: unknown): string {
  return String(value ?? "—").replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

/** Parent Run uses the same report theme; numeric scores remain the stored aggregation. */
export function renderRunReport(summary: BatchWorkflowSummary): string {
  const rows = summary.caseResults.map((result, index) => {
    const detail = result.reportHtml === undefined ? "—" :
      '<a href="cases/' + encodeURIComponent(result.caseId) + '/report.html">查看 Case 报告</a>';
    return "<tr><td>" + (index + 1) + "</td><td><code>" + e(result.caseId) + "</code></td><td><code>" +
      e(result.datasetId) + "</code></td><td>" + e(result.status) + "</td><td>" +
      result.scores.map(score => e(score.labelId) + ": " + e(score.score === null ? score.status : score.score.toFixed(2) + " / " + score.scale.max)).join("<br>") +
      "</td><td>" + e(((result as typeof result & {agentSessionIds?:string[]}).agentSessionIds ?? result.dshSessionIds).join(", ") || "—") + "</td><td>" + detail + "</td></tr>";
  }).join("");
  const dimensions = (summary.dimensions ?? []).map(item => "<tr><td><code>" + e(item.labelId) +
    "</code></td><td>" + e(item.score === null ? "未评分" : item.score.toFixed(2) + " / " + item.max) +
    "</td><td>" + item.scoredCases + "</td><td>" + item.unassessableCases + "</td><td>" + item.errorCases + "</td></tr>").join("");
  const datasets = (summary.selectedDatasets ?? []).map(item => "<tr><td><code>" + e(item.datasetId) +
    "</code></td><td>" + item.caseCount + "</td><td>" + e(item.evaluationLabelIds.join(", ")) +
    "</td><td>" + e(item.reason) + "</td></tr>").join("");
  const facts = [
    ["Run", summary.runId], ["State", summary.status], ["Dataset", summary.selectedDatasets?.length],
    ["Profile", summary.datasetTestProfile], ["已生成 Case 结果", summary.caseResults.length], ["计划 Case", summary.totalCaseCount],
    ["Health", summary.operationalHealth], ["Isolation", summary.securityIsolation],
  ].map(([key,value]) => "<dt>" + e(key) + "</dt><dd>" + e(value) + "</dd>").join("");
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>EvalDock Run ' +
    e(summary.runId) + "</title><style>" + reportStyle + '</style></head><body class="evaldock-v3">' +
    '<header class="topbar"><strong>EvalDock 完整 Run 报告</strong><nav><a href="#cases">Case 结果</a><a href="#dimensions">标签评分</a><a href="#plan">Planner 选题</a><a href="#audit">审计索引</a></nav><span>' +
    e(summary.status) + '</span></header><main><section class="run-summary"><div><small>Case 结果</small><strong>' +
    summary.caseResults.length + " / " + (summary.totalCaseCount ?? summary.caseResults.length) + "</strong><span>本轮记录</span></div><dl>" +
    facts + '</dl></section><section id="cases"><h2>1. 全部 Case 的真实结果</h2><table><thead><tr><th>#</th><th>Case</th><th>Dataset</th><th>状态</th><th>标签分数</th><th>Agent Session</th><th>详情</th></tr></thead><tbody>' +
    rows + '</tbody></table></section><section id="dimensions"><h2>2. 标签维度评分</h2><table><thead><tr><th>标签</th><th>分数</th><th>已评分 Case</th><th>无法判断</th><th>Judge 错误</th></tr></thead><tbody>' +
    dimensions + '</tbody></table></section><section id="plan"><h2>3. Planner 的选题记录</h2><table><thead><tr><th>Dataset</th><th>计划 Case</th><th>覆盖标签</th><th>选择原因</th></tr></thead><tbody>' +
    datasets + '</tbody></table></section><section id="audit"><h2>4. 审计索引</h2><p>Failure groups：' + e(summary.failureGroups.join(", ") || "—") +
    '</p><p>Reason codes：' + e(summary.reasonCodes.join(", ") || "—") +
    '</p><p><a href="run.json">本轮统一结果 · run.json</a></p></section></main><footer>EvalDock · ' + e(summary.runId) + "</footer></body></html>\n";
}
