# 安全审查报告（agent 相关代码）

- 分析时间：2026-10-22
- 范围：`packages/agent/src`、`packages/coding-agent/src`、`packages/ai/src`（agent 工具面 + 认证）
- 方法：只读静态分析（未修改任何文件、未运行任何命令）

## 总体评价

代码整体防御较好：所有子进程以 `spawn(argv 数组)` 启动（无 shell 拼接注入风险）、无工具 shell 参数转义问题、`auth.json` 以 0600 保护、Unix socket 0600、项目信任机制门控静态资源（`.pi/settings.json`、extensions、skills）、工具输出有截断与二进制净化、API key 不进 URL。主要风险集中在**缺少「密钥脱敏层」导致工具输出中的密钥回灌 LLM 并明文落盘**，以及**信任模型对仓库后续演进（新增恶意 `.pi` 资源）不敏感**。

## 问题清单

### 1. [高] 敏感数据暴露 / 提示注入放大器：工具输出无密钥脱敏，bash 子进程继承全部 API Key

- 位置：
  - `packages/coding-agent/src/core/tools/bash.ts:165-191`（`resolveSpawnContext` 只删 `PI_*` 变量，`OPENAI_API_KEY`、`ANTHROPIC_AUTH_TOKEN` 等全部保留）
  - `packages/coding-agent/src/utils/shell.ts:138-150`（`getShellEnv` 全量继承 `process.env`）
  - `packages/agent/src/harness/env/nodejs.ts:248-259` + `harness/tools/bash.ts:62-67`（`inheritEnv: true`，同样继承全环境）
  - `packages/coding-agent/src/core/tools/bash.ts:316-366`、`packages/agent/src/harness/tools/bash.ts:111-142`（输出原文回灌 tool result）
  - `packages/coding-agent/src/core/session-manager.ts:998,1035,1054`（完整命令+输出明文持久化）
- 利用场景：恶意仓库 README/代码注释携带提示注入 → 模型被诱导执行 `env`、`cat ~/.aws/credentials`、`printenv ANTHROPIC_AUTH_TOKEN` 等 → 输出原样进入 prompt 并发往第三方 LLM provider，同时写入 `~/.pi/agent/sessions/*.jsonl`。全仓无任何脱敏实现（grep `redact|mask|secret` 无命中），此链路无一处拦截。
- 建议：① bash 子进程环境剥离常见密钥变量或走白名单；② 工具结果（bash 输出、read 内容）在回灌 LLM 与落盘前按已知密钥模式（`sk-...`、`Bearer` 值等）脱敏；③ 会话文件同样脱敏。

### 2. [中] 敏感数据暴露：会话文件与 bash 溢出临时文件默认权限（世界可读）

- 位置：`packages/coding-agent/src/core/session-manager.ts:486,881,998,1035,1054`（`mkdirSync`/`writeFileSync`/`appendFileSync` 未指定 mode，Unix 下受 umask(022) 影响为 0644）；`packages/coding-agent/src/core/bash-executor.ts:69-74`、`core/tools/output-accumulator.ts:216`（`createWriteStream` 默认 mode）
- 利用场景：同机其他用户可读 `~/.pi/agent/sessions/*/session.jsonl`（含全部命令与输出、可能的密钥/源码/隐私）以及 `/tmp/pi-bash-*.log` 溢出文件。
- 建议：会话文件、临时输出文件统一 `mode: 0o600`，会话目录 `0o700`。

### 3. [中] 信任边界侵蚀：信任按路径持久化，仓库新增 `.pi` 恶意资源不再重新询问

- 位置：`packages/coding-agent/src/core/trust-manager.ts:44-58,216-225,231-244`；`main.ts:723-730`
- 利用场景：首次对仓库 cwd 选「Trust」后，`trustStore.get(cwd) === true` 永久短路。之后 `git pull` 更新仓库、攻击者新增 `.pi/extensions/*.ts`（扩展即任意 JS/TS 代码，经 runner 执行）或 `.pi/skills/SKILL.md`（内容注入 system prompt），每次启动静默自动加载、无任何提示。
- 建议：信任判定与资源清单指纹绑定（对 `.pi/` 资源 hash/manifest 记录快照），检测到新增/变更信任敏感资源时重新走确认流程。

### 4. [中] 配置任意命令执行面（RCE-by-config）

- 位置：`packages/coding-agent/src/core/resolve-config-value.ts:145-216`（以 `!` 开头的配置值被当作 shell 命令执行并进程级缓存）；调用点 `core/auth-storage.ts:263-266,441-447`（auth.json 的 key）、model 自定义 header `resolve-config-value.ts:256-268`
- 利用场景：`~/.pi/agent/auth.json` / `models.json` / 全局设置中 `"key": "!<任意命令>"` 即获得任意命令执行。文件本身受 0600 保护属用户私有，但结合低权限插件、共享机器其他用户可写 `$HOME`、或符号链接攻击，即升级为 RCE。属于文档化功能（类似 vault 的 `!command`），但执行面完全无审计与提示。
- 建议：保留功能但限制——仅全局配置可用、`pi auth` 写入口不产出 `!` 值、执行命令时亮出提示；或改用密钥环。

### 5. [低] bash 工具无默认超时（算力/进程滥用面）

- 位置：`packages/agent/src/harness/tools/bash.ts:11-14,41-49` + `harness/env/nodejs.ts:615-621`；`packages/coding-agent/src/core/tools/bash.ts:37-40,114-119`（`timeout` 可选，未提供时不设任何上限）
- 利用场景：提示注入可让模型执行 `while true; do :; done` 或持锁命令，占用 CPU/端口至手动终止。
- 建议：提供默认超时（如 120s）或会话级累计执行限额。

### 6. [低] 敏感数据暴露：OAuth 刷新令牌明文持久化

- 位置：`packages/coding-agent/src/core/auth-storage.ts:25,456-471`；`packages/ai/src/auth/credential-store.ts`（内存态）
- 说明：refresh/access token 以 JSON 明文写入 `~/.pi/agent/auth.json`，虽有 0600 保护与 proper-lockfile 并发锁，但无系统钥匙串/加密。属常见取舍，磁盘被物理接触或 0600 被破坏即泄露。

## 设计权衡（非漏洞，但构成放大因素）

- **bash 工具执行任意命令、write/edit 可写任意绝对路径**（含 `~` 展开、`file://`、符号链接跟随）：`packages/coding-agent/src/core/tools/write.ts:65`、`core/tools/path-utils.ts:48-50`、`packages/agent/src/harness/env/nodejs.ts:59-73`、`harness/tools/edit.ts:112-114`——无「项目目录内」约束、写前不校验符号链接，恶意提示注入可覆写 `~/.bashrc`、`~/.ssh/authorized_keys` 等（仅受 OS 权限限制）。这是本地 agent 的刻意设计，但它是提示注入放大链路的关键一环。
- **信任只门控静态资源，不门控工具使用**：bash/read/write 在任何（含未信任）项目中都对模型开放；信任模型防的是"仓库静态内容自动执行"，不防"模型被仓库内容诱导后动态执行"。
- **防御性设计核查通过**：`packages/agent/src/agent-loop.ts:379-404` 对 truncation 打断的工具调用全部拒绝执行；`harness/execution/effect-gate.ts` 提供取消/关闭闸门；UI 侧 `output-guard.ts` 防工具劫持 stdout 伪造终端输出。

## 未发现问题（已核查）

- 命令注入：`find`/`grep` 均以 argv 数组传参并正确使用 `--` 分隔符（`core/tools/find.ts:182-214`、`core/tools/grep.ts:162-168`）；bash 字符串直接作为 `-c` 脚本属设计意图，无"二次拼接注入"。
- SSRF：全仓无 `api_key=`/query 参数形式的密钥拼接；provider 请求均为标准 `Authorization` 头（`utils/headers.ts`）。
- 遥测：`core/telemetry.ts` 仅为版本/更新 ping，不含会话内容。
- 命令执行环境（`core/tools/bash.ts:172-177`）已显式删除 `PI_SESSION_FILE` 等会话变量，避免子进程外泄会话路径（`PI_*` 清理方向正确，只是未覆盖密钥变量）。

## 按严重度统计

| 严重度 | 数量 | 问题 |
|--------|------|------|
| 高 | 1 | #1 工具输出无密钥脱敏 + bash 子进程继承完整环境 |
| 中 | 3 | #2 会话/临时文件默认权限；#3 信任持久化对仓库演进不敏感；#4 配置 `!command` RCE 面 |
| 低 | 2 | #5 bash 无默认超时；#6 OAuth 令牌明文持久化 |
| 设计权衡 | 3 项 | 任意命令执行、任意路径写、信任不门控工具使用 |