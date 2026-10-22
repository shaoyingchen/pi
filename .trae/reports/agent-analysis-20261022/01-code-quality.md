# 代码质量审查报告（agent 相关代码）

- 分析时间：2026-10-22
- 范围：`packages/agent/src`、`packages/coding-agent/src`、`packages/ai/src`（agent 相关部分）
- 方法：只读静态分析（未修改任何文件、未运行测试/构建）

## 总体评价

三个包的代码整体质量较高：类型约束系统化、AbortSignal 取消语义贯穿、门控并发、JSONL 有序提交队列与 `SessionInvariantError` 检查等会话不变式严谨。主要风险集中在低层 agent loop 的错误传播、`EventStream` 生命周期与两套并行实现的行为漂移（跨包复制导致）。

## 问题清单

### 高

**H1. `agentLoop()`/`agentLoopContinue()` 失败时 EventStream 永不结束（消费者永久挂起 + unhandled rejection）**
- 位置：`packages/agent/src/agent-loop.ts:41-52`、`:81-91`
- 描述：`runAgentLoop(...).then(messages => stream.end(messages))` 链上无 rejection 处理。若 `runAgentLoop` 抛出（`transformContext`/`convertToLlm`/`beforeToolCall` 钩子抛错，或 provider 失败冲破 StreamFn 契约），`stream.end()` 永不调用：`for await` 消费者在 `EventStream`（`packages/ai/src/utils/event-stream.ts:72-84`）上永久阻塞，同时 `.then()` 产生 unhandled rejection。同包 `proxy.ts:242-252` 对同样的流正确地用 `catch` 转为 error 事件。
- 建议：promise 链加 `catch`，将错误转为 `stream.push({type:"error",...}) + stream.end()`，至少保证 `end()` 被调用。

**H2. `runAgentLoopContinue` 对调用方消息数组做原地变更（共享引用变异）**
- 位置：`packages/agent/src/agent-loop.ts:137`（`currentContext = {...context}` 仅浅拷贝），`:319`、`:348-350`、`:238`（push/替换直接写调用方数组）
- 描述：`runAgentLoop`（`:107`）会复制 `[...context.messages, ...prompts]`，而续跑路径直接改写调用方持有的数组（静默追加 partial→final 消息与工具结果），复用同一数组的消费者可能在二次持久化/渲染时重复写入。`packages/agent/src/agent.ts:440` 自身用 `slice()` 规避，但库层仍属隐患。
- 建议：续跑路径同样构造 `messages: [...context.messages]`。

**H3. `runWhenIdle` 回调内调用任何 lane 命令必然死锁**
- 位置：`packages/agent/src/harness/runtime/lane.ts:1608-1646` 与 `command()` 的 `:333-336`
- 描述：`command()` 在 `this.idleOwner !== undefined` 时等待 `Promise.race([this.idleOwner, this.stateChange])`；而 `runWhenIdle` 在 `callback()` 执行期间始终持有 `idleOwner`（`finally` 才 `releaseOwner()`）。因此回调内调用 `lane.prompt()/steer()/followUp()/compact()`（全部经 `command()`）会等待一个只有回调结束才 resolve 的 promise，形成死锁。该 API 已发布在 `AgentLane` 接口（`packages/agent/src/harness/agent-harness.ts:572`），当前 coding-agent 尚未调用，属潜在缺陷。
- 建议：运行回调前临时释放 idleOwner（回调期间允许其他命令进入）。

### 中

**M1. `AgentSession` 事件监听器抛异常会中断消息持久化并污染本轮 run**
- 位置：`packages/coding-agent/src/core/agent-session.ts:663-685`（`message_end` 才 `sessionManager.appendMessage`）+ `packages/agent/src/agent.ts:588-590`（listener 异常沿 `processEvents` 冒泡）
- 描述：任一同步 listener 抛出（UI/扩展 listener 无 try/catch），`_handleAgentEvent` 提前退出、`appendMessage` 不执行（transcript 丢消息）；异常被 `runWithLifecycle` 当作运行失败进入 `handleRunFailure`，再次触发同一 listener 反复抛错，整个 run 被错误标记失败。
- 建议：`processEvents`/`_handleAgentEvent` 对单个 listener 的异常隔离（记日志继续），持久化与监听解耦。

**M2. 工具实现跨包整段复制，行为漂移风险 + `catch (error: any)`**
- 位置：`packages/coding-agent/src/core/tools/{read,edit,truncate,bash}.ts`、`bash-executor.ts`、`edit-diff.ts` 与 `packages/agent/src/harness/tools/*`、`harness/utils/truncate.ts` 为两份近乎逐行一致的实现
- 描述：read 的 offset/limit/截断提示、edit 的 fuzzy 匹配、bash 的 truncateTail+spill 各自独立维护，已见细微差异（harness 版 `env.exec` capture 语义 vs coding-agent 版自定义滚动缓冲）。修复/增强需两处同步，易漂移。另 `packages/coding-agent/src/core/tools/read.ts:183` 的 `catch (error: any)` 违反仓库 no-any 约定。
- 建议：以单包为唯一真源，另一包复用；`any` 收紧。

**M3.（需验证）溢出压缩 `willRetry` 路径尾部保留 assistant 时 `agent.continue()` 可能抛错**
- 位置：`packages/coding-agent/src/core/agent-session.ts:2410-2421` + `packages/agent/src/agent.ts:371-385`（`continue()` 要求最后一条非 assistant）
- 描述：仅在尾部 assistant 的 `stopReason` 为 `error|length` 时再删一次，随后 `return true` 触发 `agent.continue()`；若压缩重建后尾部是保留的非 error/length assistant，会抛 "Cannot continue from message role: assistant"。按 cut 点规则正常流程尾部应是 user/toolResult，故发生条件苛刻——需验证。

**M4. `SessionManager._persist` 首次落盘用 `"wx"` 独占创建，失败中断整个 message_end 链路**
- 位置：`packages/coding-agent/src/core/session-manager.ts:1044`
- 描述：首个 assistant 消息 `openSync(this.sessionFile, "wx")`，若目标文件已存在（同名残留、其他进程/人工干预），`EEXIST` 沿 `appendMessage` → `_handleAgentEvent` 冒泡，该消息不持久化且本轮 run 进入失败流程。低概率健壮性问题。
- 建议：`EEXIST` 时回退追加模式。

### 低

**L1. `Agent.prompt()` 对空文本/无内容消息无校验** — `packages/agent/src/agent.ts:402-406`：空字符串产生空 content user 消息走完整循环；harness `acceptRun`（`harness/runtime/lane.ts:615-625`）会拒绝空 prompt，两处行为不一致。

**L2. `transformMessages` 合成工具结果一律标 `isError: true`，且 `existingToolResultIds` 在含 toolCall 的 assistant 处被重置** — `packages/ai/src/api/transform-messages.ts:163-180`（"No result provided" 结果带 `isError: true`，模型可能误判失败）、`:203`（新 assistant 清空集合，toolResult 顺序异常跨 assistant 时漏判合成，需验证）。

**L3. `openai-completions.ts` 使用 `(choice as any).usage`** — `packages/ai/src/api/openai-completions.ts:567-568`：`any` 断言 + 非标准字段，`parseChunkUsage` 无保护。

**L4. `retryAssistantCall` 背压中断改写 `stopReason:"aborted"` 时丢弃原始错误** — `packages/ai/src/utils/retry.ts:217-219`：解构掉 `errorMessage`，调用方丢失原错误类型（429/超时），日志/UI 只剩 "Aborted"。

**L5. `output-guard.ts` 写 stdout 失败直接 `process.exit(1)`** — `packages/coding-agent/src/core/output-guard.ts:90-92`：刻意快速失败，但对插件/修复场景过于粗暴，与 TUI 其它恢复逻辑不统一。

## 统计

| 包 | 高 | 中 | 低 |
|----|----|----|----|
| packages/agent | H1,H2,H3 | — | L1 |
| packages/coding-agent | — | M1,M2,M3,M4 | L5 |
| packages/ai | — | — | L2,L3,L4 |

合计：高 3、中 4、低 5（M3 标注需验证）。

已排除疑点：`agent_end.messages` 在 continue 路径仍含本轮消息（agent-loop.ts:213/239 会 push），`_willRetryAfterAgentEnd` 判定不受影响；`bash-executor` 偏移缓冲在溢出阈值关系上不构成输出丢失；`proxy.ts:191` 裸 `JSON.parse` 已有外层 catch 兜底。