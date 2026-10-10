# 自制数据集的最小模板

`minimal/` 是 Docker 发行版计划内置的唯一示例题包：一个数据集、一道 Case。它只验证输入投递、文件交付、Trace 和 Judge 链路，不代表正式评测覆盖。

```text
minimal/
├── catalog.md
└── basic-file-delivery/
    └── case-001/
        ├── question.json
        ├── input/numbers.json
        └── private/final.json
```

- `catalog.md`：数据集 ID、说明、评分标签和题量；目录名与 ID 去掉 `dataset.` 和 `/v1` 后一致。
- `question.json`：公开任务、输入映射、超时、允许的输出路径，以及评分材料引用。
- `input/`：提供给 Agent 的公开输入；声明 SHA-256 后，输入变更必须同步更新摘要。
- `private/`：仅供 Judge 使用的参考材料，不会播种到 Agent 的工作目录。

复制该目录后修改 ID、任务、输入和参考答案，即可制作自己的题目。一个数据集可放多个同级 Case 目录，各含一份 `question.json`；多个数据集应在同一个 catalog 中登记。标签复用根目录 `labels/` 的现有标准，catalog 必须覆盖每道题声明的标签。

当前源码编译后，可以只读验证模板，无需启动 Agent 或调用模型：

```sh
node --input-type=module <<'JS'
import {loadDatasetDescriptionCatalog} from './dist/src/datasets/catalog.js';
import {loadDatasetCase} from './dist/src/datasets/loader.js';
const root = 'examples/datasets/minimal';
const [dataset] = await loadDatasetDescriptionCatalog(root + '/catalog.md');
const item = await loadDatasetCase({datasetsRoot: root, datasetId: dataset.datasetId, labelIds: dataset.labelIds});
console.log({dataset: dataset.datasetId, case: item.caseId, inputs: item.inputs.length});
JS
```

首次运行这个模板应手动指定唯一 Case，不能要求 Planner 从一个示例数据集中挑选 3–10 个数据集。Docker 的示例安装、持久化目录挂载与工作台导入入口尚待实现；不要把本模板目录误当作已经可一键启动的发行包。

正式数据集按发行要求从 EvalDock 官网另行下载，或由用户自行制作并装载。官网数据包下载入口及 Docker 装载流程完成后，再补充对应操作说明。
