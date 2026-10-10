EvalDock's first source preview includes the local workbench, eight agent adapters, shared All Trace evidence, and scoring on a 0–100 scale.

### Install

1. Download and extract either source archive below.
2. Install Node.js 24 and pnpm 11.24.0.
3. Follow `docs/NATIVE_SETUP.md` to configure your agents and start the workbench.
4. Enter your own Planner and Judge credentials in **System Settings**.

This release targets the existing native macOS setup. Agents must be installed and configured separately. Starting the current workbench requires a configured DSH Web Profile. Codex and Claude Code adapters are planned, not included.

### Included

- DSH, Pi, OpenClaw, Hermes, WorkBuddy, Qwen Work, Doubao Work, and LangGraph adapter code.
- Event-triggered trace collection, bounded evidence, per-dimension Judge records, and JSON / HTML reports.
- English and Chinese documentation, plus a basic case template.
- One synthetic demo task in the default dataset catalog. Additional public tasks are distributed separately through BenchDock; see `docs/BENCHDOCK.md`.

### Distribution status

This is a source prerelease, not a ready-to-run Docker distribution. It does not include agent executables, accounts, API keys, VM images, or personal evaluation results. Docker packaging and a native Runner are still being prepared; the intended Docker distribution will contain only the basic case template.

The release workflow runs the type checks, build, contract tests, and model-settings tests before publishing. These checks do not replace real-agent validation on a user's machine.

`SHA256SUMS` verifies the attached archives and release metadata. `COMMIT.txt` identifies the exact source commit. After downloading all assets, run `shasum -a 256 -c SHA256SUMS` on macOS, or `sha256sum -c SHA256SUMS` on Linux.

---

本次为源码预发布：提供本地工作台、8 类 Agent 适配、统一 All Trace 与百分制 Judge。按包内 `docs/NATIVE_SETUP.md` 安装，Agent 和模型账号需自行配置；当前工作台仍需要已配置的 DSH Web Profile。

此包不是开箱即用的 Docker 发行版，不包含 Agent 安装文件、API Key、虚拟机或个人测试结果。默认题库仅包含一道合成演示题，其他公开任务按 `docs/BENCHDOCK.md` 独立获取和导入；计划中的 Docker 包仅附一道基础 Case 模板。
