# 客户端运行接口

EvalDock 核心保留 `src/`、`adapters/`、Judge 标签、规划和高级工作台。桌面壳、主界面、图标、更新及安装包脚本在 [EvalDock-APP](https://github.com/evaldock/EvalDock-APP) 维护。核心不依赖 Electron 或客户端源码。

## 构建接口

```sh
pnpm install --frozen-lockfile
pnpm run verify
node --test workbench/lib/model-settings.test.mjs
pnpm run runtime:export /tmp/evaldock-core-runtime
```

导出脚本的第一个位置参数是输出目录；直接调用 `node scripts/export-runtime.mjs /tmp/evaldock-core-runtime` 与上面命令等价。它先检查发布边界，再收集 Git 跟踪的运行资源、当前构建产物和所需 Node 依赖，输出 `core-runtime.json`（`evaldock.core-runtime/v1` 与源提交 SHA）。契约测试及本地用户数据不属于运行资源。导出前必须已构建当前源码。

`workbench/runtime.mjs` 是客户端启动接口，提供控制服务、线上题库、选题与事务导入。客户端用自己的 `desktop/server.mjs` 编排启动及关闭；HTTP 控制与公开任务投影仍由核心实现。客户端将自己的主界面叠加到导出资源中的 `workbench/design-prototypes/`，高级工作台由核心继续维护。

题库校验、指纹与备份切换集中在 `workbench/lib/library-workspace.mjs`；它们不依赖桌面目录。私有评分参考继续只交给 Judge，下载状态、接口检查、执行和评分保持独立状态。

## 依赖更新与同步

客户端的 `core.lock.json` 指向本仓库一个已推送的完整提交 SHA。客户端只从固定核心导出运行资源；缓存位于客户端的 `.cache/evaldock-core`，本地有修改时构建拒绝覆盖。不依赖相邻工作树，不把核心源码复制进客户端 Git 历史。

更新接口时先完成本库检查、提交并推送，再在客户端更新锁文件，完成客户端检查、实际启动与适用的打包验收。运行资源布局或接口有不兼容变化时升级 manifest schema，客户端明确支持后再更新锁定提交。

开发 VM 核心工作树仍为 `evaldock-dev:~/Projects/EvalDock-app`（`app`）。客户端采用独立的 `~/Projects/EvalDock-desktop`（`main`）；macOS 常见文件系统不区分目录名大小写，不能用 `EvalDock-APP` 覆盖已有 `EvalDock-app`。保留原 `~/Projects/EvalDock` 及运行服务和用户数据。
