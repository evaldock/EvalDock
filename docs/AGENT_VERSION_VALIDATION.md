# Agent 跨版本实测

兼容性门禁通过，只说明记录中的安装、配置与所需能力通过了检查。验证“跨版本”必须运行不同的真实发布包；修改版本字符串、模拟接口和复用另一版本的通过记录不能替代实测。

## 选择和安装

每个 Agent 先选择一个旧版、当前使用版和一个较新版。记录准确的包名、版本、官方发布来源与完整性摘要；预发布版应单独标注。不要把不同 Agent 各测试一个版本称为跨版本验证。

在虚拟机独立目录安装额外版本，保留当前安装、配置和运行中的服务。npm 包为每个版本保存 `npm view <package>@<version> name version dist.tarball dist.integrity --json` 的输出、安装日志及独立的 `package-lock.json`，并使用精确版本安装。不能用自动更新命令替换基线安装。

先满足该版本声明的 Node/Python 要求，再开始接口验收。安装器拒绝不受支持的运行时属于环境问题，不证明 Agent 接口不兼容。需要不同运行时时，记录每个版本使用的运行时；不要把运行时与 Agent 同时变化的结果当作单一变量对照。

## 独立桌面安装

WorkBuddy 版本验收可通过 `createWorkBuddyAdapter({ appPath, endpoint, targetId })` 选择独立安装及回环 CDP 端口。默认仍连接 `/Applications/WorkBuddy.app` 和端口 `18491`。只接受本机 HTTP 来源，Renderer 文件地址必须精确匹配所选安装，应用 bundle ID 校验不变；版本不能从另一个已运行实例借用。

千问和豆包的目标配置同样支持 `appPath` 与 `endpoint`。千问验证所选 Renderer 文件地址；豆包的自定义 scheme 不能标识安装目录，因此还核对端口监听进程所属的应用。不同安装的登录状态可能独立，接口连通不代替登录检查。WorkBuddy 独立配置使用客户端支持的 `WORKBUDDY_CONFIG_DIR` / `WORKBUDDY_USER_DATA_DIR`，不能仅依赖 Chromium 的 `--user-data-dir`。

额外实例使用该客户端支持的独立配置目录，保留现用安装与配置。首次启动可能进行迁移或初始化，应等连接和登录检查就绪后再验收。失败记录保留；清理无法确认时先结束本次独立实例及其所属进程，再按兼容性恢复流程检查拦截记录，不能直接删记录重试。

Python Agent 的额外环境需使用各版本声明支持的 Python 及依赖约束，保存最终依赖清单。检查 `pip freeze` 中的源码路径依赖，避免名义上安装额外版本却仍引用当前源码。首次导入超时与明确的 CLI／事件协议缺失要分别记录；预热后仍需经过正常准入和完整评测，不能跳过检查。

## 执行同一验收

为各安装创建独立的本地目标配置和 ID，沿用相同模型、题目与工具选择。核对安装清单版本和可执行文件的原生 `--version` 输出，记录可执行文件摘要。包名或版本不符时停止，不能把请求安装的版本当成实际安装版本。

通过现有适配器和 `adapters/shared/evaluation.mjs` 的 `runEvaluation` 运行完整评测。该入口首先执行兼容性门禁，再执行题目、采集 Trace、调用 Judge 并生成报告。首轮可统一选择 `dataset.basic-file-delivery/v1` 的 Case 0；这是合成链路验证，不能替代业务题库验收或用于能力排名。

DSH 使用自身正式 CLI，保留原有 Inspector 与执行流程。也可以通过现有 `--evaluation-config` 的 `SELECTED` 方案指定上述 Case；此时记录为指定题目验收，不宣称自动 Planner 通过。自动规划的模型输出格式失败需另行保存，不能放宽校验或改写失败记录来获得通过结论。

记录每个版本的文本、两次文件会话、工具调用与结果、取消、清理结论，以及正式评测的完成状态、各标签评分状态与报告位置。只有兼容性通过、任务完成、证据采集和预期评分均完成，才能写“本轮完整验收通过”。评分为零仍是有效评分；证据不足和 Judge 错误不能改写成通过。

如遇不兼容，保留首次失败记录，定位具体命令、接口或事件差异。修改适配器后重新运行受影响版本和当前版本的回归，记录修复前后驱动指纹；不能只重测失败项便宣称整条链路通过。

## 保存与解释结果

原始记录、安装路径、执行脚本、锁文件和报告留在本地或虚拟机的 `var/version-matrix/` 及 `var/evaluation-results/`，不提交到公共仓库。记录实际 Git 提交、未提交变更和验收报告中的驱动指纹，避免把工作树测试误称为仅提交代码的测试。比较各版本的真实可执行文件摘要，确认不是同一个安装入口。

汇总必须区分安装失败、环境阻塞、不兼容、待判定、专项检查通过和完整评测通过。结论只适用于记录中的版本、平台、模型配置与能力范围；通过相邻版本或某个大版本，不承诺所有未来版本兼容。后台升级与自动编码修复不属于本流程。

## 业务验收证据索引模板

对应 [App 清单 21](APP_TODO_20261013.md)。模板与关联检查可用合成材料完成；填写真实业务结论仍需要授权题目、参考、运行环境和实际运行证据。本节不授权启动评测。索引保存在受控结果目录，公共清单只记录脱敏结论、提交与可追溯编号，不放原始任务、评分参考、凭据或个人绝对路径。

| 必填信息 | 记录及核对方法 |
| --- | --- |
| 材料性质与代码 | `SYNTHETIC` 或 `BUSINESS`；完整 Git SHA、脏文件相对路径及 SHA-256、验证时间；未提交修改不能只写提交号 |
| 环境与目标 | OS/架构、Node/Python、目标 ID、Agent 名称/安装版本/文件摘要、协议驱动/兼容性凭证编号；合成对象明确标为 fixture，真实路径仅留受控目录 |
| 题目与参考 | 数据集/Case ID、导入回执或来源版本、公开输入摘要、授权参考摘要及版本；参考缺失写原因和 UNASSESSABLE，不填写虚构参考 |
| 计划与执行 | `plan.json` 的队列与 `run.json` 的逐题记录、run ID、target ID；选中/开始/完成/失败/取消/未确认分别计数，缺会话或中断记录不能直接算未开始 |
| 每题证据 | `session.json`、交付文件、All Trace 清单及分片、Judge 请求/响应或缺失原因、JSON/HTML 报告的相对路径和 SHA-256；没有 Judge 调用时说明原因，不伪造 Judge 文件 |
| 状态与边界 | 执行状态、逐标签 SCORED/UNASSESSABLE/ERROR、原始量表、有效零分、清理结论；缺少证据写待核对，不能以计数或脚本通过替代内容验收 |

文件清单覆盖实际材料；目录本身不作为文件摘要条目，须列出需要核验的文件。报告的 `runId`/`scope.runId`、`scope.targetId`、`scope.caseId` 与索引一致；共享适配器的计划用 `agentId`，运行汇总用 `targetId`。DSH 等记录布局需按实际入口核对，不能强行套用共享适配器路径。

下面是共享适配器的填写骨架，尖括号均为待填项，不能作为验收结果。其余必填信息按上表补全；`files` 还应列出实际会话、交付物、Trace、Judge 与 HTML 文件及摘要。运行在规划前失败时可能没有计划/报告，应登记为“不具备本模板的完整关联条件”并保存失败证据，不补造文件。

```json
{
  "material": "SYNTHETIC",
  "code": {"commit": "<完整 Git SHA>", "dirtyFiles": []},
  "environment": {"os": "<系统及架构>", "runtime": "<运行时版本>"},
  "target": {"id": "synthetic-agent", "version": "fixture", "installationDigest": "<摘要>", "compatibility": "NOT_RUN"},
  "library": {"source": "synthetic fixture", "importDigest": "<摘要>", "referenceDigest": "<摘要或缺失原因>"},
  "runId": "synthetic-run",
  "cases": [{"caseId": "synthetic-case", "datasetId": "synthetic-dataset", "execution": "NOT_RUN", "scoring": "NOT_RUN"}],
  "files": [
    {"role": "plan", "path": "plan.json", "sha256": "<文件摘要>"},
    {"role": "run", "path": "run.json", "sha256": "<文件摘要>"},
    {"role": "case-report", "caseId": "synthetic-case", "path": "cases/synthetic-case/report.json", "sha256": "<文件摘要>"}
  ]
}
```

将已填写索引保存为受控运行目录的 `evidence-index.json`。以下只读检查核对列出的文件摘要和计划/运行/报告身份，缺文件、重复条目或 ID 不一致会失败。它不验证任务答案、评分质量、材料授权、报告内部签名或未列出的文件，也不等价于完成业务验收。执行前用实际受控目录替换命令中的目录占位符；不使用 `python -O` 跳过断言。

```sh
python3 - /path/to/authorized/run <<'PY'
import hashlib, json, pathlib, re, sys
root = pathlib.Path(sys.argv[1]).resolve()
index = json.loads((root / 'evidence-index.json').read_text())
assert index['material'] in ('SYNTHETIC', 'BUSINESS')
assert re.fullmatch(r'[0-9a-f]{40}', index['code']['commit'])
assert isinstance(index['code']['dirtyFiles'], list)
target, run_id = index['target']['id'], index['runId']
cases = {case['caseId'] for case in index['cases']}
assert cases and len(cases) == len(index['cases']), 'empty or duplicate Case IDs'
records, listed = {}, set()
for entry in index['files']:
    relative = pathlib.Path(entry['path'])
    file = (root / relative).resolve()
    assert not relative.is_absolute() and file.is_relative_to(root), 'path outside run'
    assert entry['path'] not in listed, 'duplicate file'
    listed.add(entry['path'])
    assert file.is_file(), 'missing file: ' + entry['path']
    data = file.read_bytes()
    assert hashlib.sha256(data).hexdigest() == entry['sha256'], 'digest mismatch: ' + entry['path']
    if entry['role'] in ('plan', 'run', 'case-report'):
        key = (entry['role'], entry.get('caseId'))
        assert key not in records, 'duplicate evidence role'
        records[key] = json.loads(data)
plan, run = records[('plan', None)], records[('run', None)]
assert plan['runId'] == run['runId'] == run_id, 'run ID mismatch'
assert plan['agentId'] == run['targetId'] == target, 'target ID mismatch'
queue = [case['caseId'] for case in plan['queue']]
executed = [case['caseId'] for case in run['caseResults']]
assert len(queue) == len(set(queue)) and set(queue) == cases, 'plan Case IDs mismatch'
assert len(executed) == len(set(executed)) and set(executed) <= cases, 'run Case IDs mismatch'
assert {case for role, case in records if role == 'case-report'} == cases, 'report Case IDs mismatch'
for case_id in cases:
    report = records[('case-report', case_id)]
    assert report['runId'] == report['scope']['runId'] == run_id, 'report run ID mismatch'
    assert report['scope']['targetId'] == target and report['scope']['caseId'] == case_id, 'report scope mismatch'
print('Index association passed; material=' + index['material'] + '; this is not an evaluation verdict')
PY
```

关联通过后仍需人工核对每题交付内容、Trace 来源和覆盖、Judge 引用、状态/数量及原量表。21A 的合成正反例只验证该索引过程；21B 在没有真实证据前保持未完成。
