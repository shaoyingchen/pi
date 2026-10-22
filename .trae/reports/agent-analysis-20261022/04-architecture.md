# 架构审查报告（agent 相关代码）

- 分析时间：2026-10-22
- 范围：全仓库，聚焦 `packages/agent`、`packages/coding-agent`、`packages/ai` 及包间依赖
- 方法：只读静态分析（未修改任何文件、未运行任何命令）

## 1. 总体架构评价

包边界与依赖方向整体清晰且被 CI 机械化约束（check-runtime-deps/check-ts-relative-imports/check-entry-graphs），harness 运行时（AgentHarness/Session/Lane/Drive）是文档驱动的精致状态机设计，是仓库最强的部分。主要风险是**两代架构并存且迁移未完成**：coding-agent 的生产路径仍是基于 `Agent` 类的"旧"架构（3552 行 agent-session.ts + 自研 compaction/session-manager/tools/skills + pi-ai/compat 过渡层），新一代 harness（packages/agent/harness + chord + client/protocol/server）只在 experimental/ 目录与 agent 包内落地，导致 compaction、edit-diff、truncate、工具、skills 等大量逻辑在两包间逐字重复维护，并伴随多个 2000~6000 行级巨型文件。

## 2. 分维度结论

**包边界（优）**：依赖单向无环：`telemetry → ai → agent → coding-agent`；agent 对 chord 仅 type-only 引用（`packages/agent/src/harness/agent-harness.ts:1`、`context.ts:1`、`session/types.ts:1`）；ai 只依赖 telemetry（`packages/ai/src/types.ts:1`）；agent 不引用 client/protocol/server/tui。`scripts/check-runtime-deps.mjs`、`scripts/check-ts-relative-imports.mjs`、`scripts/check-entry-graphs.mjs`（入口图预算制，如 `./harness/session` 限 25 文件并禁引 runtime）把边界做成提交期检查。

**分层（中）**：agent 包内 `harness/runtime|session|tools|env` 分层良好，drive 用扁平 `at` 13 叶状态全量 dispatch（`packages/agent/src/harness/runtime/drive.ts:56-92`），并有"每轮必须前进否则抛 invariant"保护（`drive.ts:102-104`）。coding-agent 侧 core/modes/cli 大体清晰，但 `main.ts`（981 行）装配过重；且 experimental/（session-worker、mini、client-runtime）与 core/ 两套会话运行时同包并存——bundle 只打包 cli/index/rpc-entry（`scripts/build-coding-agent-bundle.mjs:145-152`），experimental 游离于发布物之外存在漂移风险。

**抽象一致性（差）**：同一仓库存在**三套工具接口**：`AgentTool`（`packages/agent/src/types.ts:387`）、`AgentHarnessTool`（`packages/agent/src/harness/types.ts:108`）、`ToolDefinition`（`packages/coding-agent/src/core/extensions/types.ts:451`），coding-agent 还需 `tool-definition-wrapper.ts` 在两者间转换。事件模型双轨：legacy `AgentEvent` 与 harness `HarnessEvent/LaneWatchEvent`。会话持久化两套 JSONL：coding-agent 自研 v1~v3 迁移（`core/session-manager.ts`）vs harness jsonl v4（`agent/src/harness/session/jsonl/codec.ts:60-62` 只为读旧格式而兼容 v3）。telemetry：harness 有 schema 化定义（`harness/telemetry.ts` 635 行 + docs/telemetry-schema.md），legacy 路径基本未接入。

**可扩展性（中）**：provider 注册是亮点：`ai/src/models.generated.ts` 由脚本生成、`providers/all.ts` 聚合 40+ provider、`.lazy.ts` 延迟加载模式统一。但插件/扩展机制仍是两套（legacy `extensions/runner.ts`(1286 行)+`types.ts`(1797 行) vs harness `HookRegistry`+`HookMap`，`agent/src/harness/agent-harness.ts:430-514`），`docs/plugins.md` 描述的 chord 服务/facet 架构远超前于 experimental/ 实际落地（文档自身标注 Design specification/proposed）。

**状态管理（优）**：harness 是仓库最成熟的部分：`reduceLaneSnapshot` 纯 reducer（`runtime/reducer.ts:22-232`）、restore 时 intent/state 一致性校验（`runtime/restore.ts:156-159`）、`Session` 批式 `Write[]` 提交与 `MutationLine`（`session/session.ts:95-120`）、flat 13 叶 OperationState（docs/runtime-simplification.md 记载 7410 行运行时缩减历史）、`continueOperation/settleOperation` 两个具体操作而非通用 Procedure 抽象——状态机纪律严格，无过度抽象。legacy `Agent.processEvents`（`agent.ts:544-591`）是小型 switch reducer，也清晰。

## 3. 问题清单

**高-1 两代架构并存，重复实现跨包逐字复制（结构性债务）**
- `packages/agent/src/harness/compaction/compaction.ts`(865 行) vs `packages/coding-agent/src/core/compaction/compaction.ts`(1012 行)：`extractFileOperations`、`computeFileLists`、`createFileOps`、`serializeConversation` 逐字同构（前者 L46-76、后者 L42-70）；branch-summarization（300 vs 382 行）、compaction/utils（132 vs 158 行）同样成对。
- `packages/agent/src/harness/tools/edit-diff.ts:7-50` vs `packages/coding-agent/src/core/tools/edit-diff.ts:11-50`：`detectLineEnding/normalizeToLF/restoreLineEndings/normalizeForFuzzyMatch` 连注释都逐字复制。
- `truncate.ts`（`agent/harness/utils/truncate.ts` vs `coding-agent/core/tools/truncate.ts`）同名函数集 `truncateHead/truncateTail/truncateLine/formatSize`；bash/edit/read/write 工具、skills 加载（两边同为 `MAX_NAME_LENGTH=64`、`MAX_DESCRIPTION_LENGTH=1024`、`IGNORE_FILE_NAMES`、`loadSkills`）均成对存在。
- 这是刻意但未完成的双代迁移（`packages/ai/src/compat.ts:9-10` 自述"deleted with the coding-agent ModelManager migration"）。建议：为 compat 层与 legacy session-manager 设删除期限；compaction/工具以 agent 包为唯一真源，coding-agent 复用而非复制；显式迁移里程碑。

**高-2 三套工具/两套事件接口并存**
- 工具：`AgentTool`（agent/src/types.ts:387）、`AgentHarnessTool`（agent/src/harness/types.ts:108）、`ToolDefinition`（coding-agent/src/core/extensions/types.ts:451），并有转换器 `createToolDefinitionFromAgentTool`（coding-agent/src/core/tools/tool-definition-wrapper.ts）。建议收敛为单一工具契约，wrapper 层仅在过渡期保留。

**高-3 巨型文件导致隐性耦合**
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`：**6620 行**（虽已拆 components/，主文件仍是神类）。
- `packages/coding-agent/src/core/agent-session.ts`：**3552 行**（已拆 agent-session-runtime.ts 449 行与 agent-session-services.ts 221 行，方向正确，继续细分）。
- `packages/agent/src/harness/runtime/lane.ts`：**2012 行**；另有 coding-agent `extensions/types.ts`1797、`session-manager.ts`1746、`settings-manager.ts`1417、`extensions/runner.ts`1286、`core/package-manager.ts`2699、`main.ts`981、`core/model-runtime.ts`795。建议按职责拆至数百行级并显式暴露依赖。

**中-4 `any` 泛滥与工程约束矛盾**
- `packages/agent/src/types.ts:444-446`：`tool_execution_start.args: any`、`partialResult: any`——与 harness 侧强类型 `AgentToolResult` 形成反差；同文件 L384/387 `TDetails = any`、L421 `AgentTool<any>[]`。
- `packages/coding-agent/src/core/agent-session.ts` 约 20 处 `Model<any>`（L206/263/906…）、`core/compaction/compaction.ts` L556-971 等 7 处、`modes/rpc/rpc-mode.ts:82` `value: any`、`core/export-html/tool-renderer.ts:66: any`。
- `packages/ai/src/utils/validation.ts:302,317`：`validateToolCall/validateToolArguments` 返回 `any`。
- 多数源自 compat 过渡 API（`Model<TApi>` 被 `Model<any>` 消解），与 AGENTS.md "No any unless absolutely necessary" 冲突。建议迁移收口时一并收紧；rpc-mode/export-html 两处应立即类型化。

**中-5 包件内部暴露面过大**
- `packages/ai` exports 把 `./providers/*`、`./api/*`、`./utils/*` 全部开放（package.json L22-33）；coding-agent 直接 `import * as builtinProviderCatalog from "@earendil-works/pi-ai/providers/all"`（`core/model-runtime.ts:39`）绕过封装层。建议收紧为 `all.ts`/registry 级入口，内部文件仅对 lazy 装载器开放。

**中-6 experimental/ 与发布物漂移**
- coding-agent 的 client/protocol/server 均为 devDependencies（package.json L76-78），仅 experimental/ 引用（如 `experimental/client-runtime.ts:3-5`、`server.ts:14-24`），不进 bundle。实验代码不受发布约束保护，而 plugins.md 的 facet/服务规范又超前于实现。建议为 experimental 增加构建入口与 CI 覆盖，避免"规范—实验—生产"三处语义不一致。

**低-7 自动化检查覆盖面缺口**
- `scripts/check-entry-graphs.mjs:21-27` 的 WORKSPACE 映射只含 chord/ai/agent/telemetry/tui，缺 client/protocol/server；预算表为手工维护，新增入口易漏配。
- `check-ts-relative-imports.mjs` 与 AGENTS.md "No inline imports" 存在少量已存在例外（`coding-agent/src/utils/photon.ts:128`、`ai/src/api/openrouter-images.lazy.ts:5`，后者属 Lazy 模式可豁免）——建议在检查脚本中显式声明允许项而非人工豁免。
- 低（一致性小点）：`packages/agent/src/harness/agent-harness.ts:77-82` 存在"constructed when M8 exposes public drive"实现进度注释残留；docs/plugins.md 多处 "future/possible"，文档-代码时序脱节，建议标注落地状态。

## 4. 依赖图（简化）

```
telemetry（无依赖）
   ▲
ai ────────────► telemetry, typebox, Anthropic/OpenAI/Google SDK…
   ▲
agent ─────────► ai, telemetry, chord(仅类型), diff, ignore, yaml
   ▲                      ▲
coding-agent ──► agent, ai, tui, chord, photon; (devDeps) client, protocol, server
   │
   ├─ 生产路径    ：packages/agent(Agent 类) + ai/compat + 自研 compaction/session-manager/tools/skills
   └─ experimental：chord + server/client(protocol) + harness(AgentHarness/Lane/Session/JsonlRepo)
   ▲
evals ──────────► ai, coding-agent（dev）

protocol ─► chord;  client ─► protocol, chord;  server ─► agent, chord, protocol
```

说明：chord/client/protocol/server 构成实验性远端会话链路（server 直接消费 harness 的 `BACKGROUND_CONTEXT/SessionMetadata`，`server/src/server.ts:11`）；harness "新栈"已就位，但 coding-agent 出厂行为仍走旧栈，这是读整个仓库时最需要注意的架构事实。