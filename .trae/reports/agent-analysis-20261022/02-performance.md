# 性能分析报告（agent 相关代码）

- 分析时间：2026-10-22
- 范围：`packages/agent/src`、`packages/coding-agent/src`、`packages/ai/src`（agent 相关热路径）
- 方法：只读静态分析（未修改任何文件、未运行基准）

## 总体评价

整体设计已具备较强性能意识：追加式 JSONL、shell 输出自适应限流发布、帧编码只传增量、逐轮上下文构建 O(n) 线性。最值得优先优化的点：**流式响应每个 delta 事件都触发一次 JSONL 文件 append 的同步序列化 I/O**（harness 帧持久化）；其次是**交互 bash 执行路径无节流且滚动缓冲为 O(n²)**、**bash 工具每次更新全量 JSON.stringify 输出快照**。

## 问题清单

### 高

**P1. 每个流式 delta = 一次 JSONL 文件 append（无批处理/节流/背压）**
- 位置：`packages/agent/src/harness/runtime/progress.ts:44-67`、`harness/runtime/drive/response.ts:70-76`、`harness/session/jsonl/storage.ts:138-151`、`harness/env/nodejs.ts:778-793`
- 描述：observer 在每 `text_delta/thinking_delta/toolcall_delta` 调用 `progress.write(frame)` → `openProgress.write` 直接 `lane.command → session.mutate → storage.commit → fs.appendFile`（每次真实 syscall）。长响应上千 delta 即上千次串行文件追加；`write` 是 fire-and-forget，commit 队列 pending promise 随 delta 无界堆积，无背压。对比同目录 shell 输出已用 `AdaptivePublisher`（100ms 最小间隔），帧路径没有任何节流。
- 建议：帧写入按时间（≥50ms）或数量（每 32 帧）批量提交一次；commit 队列加有界水位/背压；保留 `drain()` 的落盘语义。

**P2. 交互 bash（! 命令）路径：滚动缓冲 O(n²) + 每 chunk 无节流事件广播**
- 位置：`packages/coding-agent/src/core/bash-executor.ts:56-105`、`agent-session.ts:3020-3031`
- 描述：`onData` 中 `outputChunks.shift()` 为 O(数组长度)；100KB 上限内大量小 chunk（10 字节/chunk）数组可达 ~10k 元素，每 chunk shift 拷贝万级引用 → 整体 O(n²)（≈10⁸ 次引用拷贝，明显卡顿）。同时每 chunk 同步 `_emit({type:"bash_execution_update"})` 广播给所有监听者，无任何限流（harness 侧 bash 有 100ms 自适应限流）。
- 建议：环形缓冲/块链式存储（或复用 `OutputAccumulator` 的 `tailText` 增量维护）；`bash_execution_update` 按 100ms 合并发出。

**P3. harness bash 工具每次输出更新都全量 JSON.stringify 快照**
- 位置：`packages/agent/src/harness/tools/bash.ts:96-100`
- 描述：`const encoded = JSON.stringify(snapshot)` 在每次 `onUpdate`（≥100ms 限流）都执行，即使 2s 检查点间隔未到；snapshot 含完整 view.text（上限 ~200KB）。按 10Hz ≈ 2MB/s 纯 JSON 编码开销，仅为了与上一检查点比较。
- 建议：`encoded` 计算挪到 `now - lastCheckpointAt >= BASH_CHECKPOINT_INTERVAL_MS` 分支内。

### 中

**P4. 输出视图每次发布都全量重新截断（split 全部行 + 逐行字节计算）**
- 位置：`packages/agent/src/harness/utils/output-capture.ts:93-113`（`snapshot()` → `truncateTail`）；`packages/coding-agent/src/core/tools/bash.ts:260-272`
- 描述：`OutputCapture` 已增量维护行数/总字节，但快照仍对整段尾缓冲（≤~200KB）重 split+逐字符字节统计，每 100ms ≈ 2MB/s 字符处理；coding-agent 侧 `OutputAccumulator` 同样。注意"未截断"分支也会先做全量 split+统计。
- 建议：用已维护的 `totalLines/totalDecodedBytes` 预判，未超限时直接返回原文本短路，避免最贵的 `truncateTail`。

**P5. read 工具带 offset/limit 仍整文件解码并切分所有行**
- 位置：`packages/agent/src/harness/tools/read.ts:102-119`、`packages/coding-agent/src/core/tools/read.ts:128-148`
- 描述：即使只读一个窗口（`offset=1, limit=200`），两实现都先 `decode + split("\n")` 全文件再截取。100MB 大文件任意窗口成本 O(文件大小) 而非 O(窗口)。
- 建议：只定位所需行区间（从 Buffer 扫描第 offset 个换行后切片，或复用 `readLines`），避免整文件字符串化和 split。

**P6. TUI footer 每帧全量扫描会话 + 全量 token 估算**
- 位置：`packages/coding-agent/src/modes/interactive/components/footer.ts:84-111`、`core/agent-session.ts:3411-3455`（`getContextUsage`）、`packages/ai/src/utils/estimate.ts:105-143`
- 描述：`FooterComponent.render()` 每次渲染遍历 `sessionManager.getEntries()`（含全部已 compaction 历史，无界增长）；`estimateContextTokens` 对所有存活消息估算，每条 assistant 的每个 toolCall 做 `JSON.stringify(arguments)`。bash 定位计时 `setInterval(…,1000)` 等定期触发重渲染，长会话下每帧 O(总 entries + 总字符 + 工具参数 JSON 序列化)。
- 建议：会话级维护增量 usage 汇总（message_end 时累加）；估算按最后 assistant usage 位置缓存，仅在 message_end/compaction 时失效。

**P7. 会话状态与 JSONL 文件无界增长；compaction 不回收旧条目、不重写文件**
- 位置：`packages/agent/src/harness/session/in-memory-storage-state.ts:78-95,141-193`、`harness/session/jsonl/storage.ts:74-114`
- 描述：`entries`/`entriesBySeq` 随会话无限追加（compaction 仅新增一条入口，旧消息/usage 行永远驻留内存）；JSONL 磁盘只增不改；`openV4` 打开时整文件读入内存逐行 JSON.parse 重放，长会话（几万 entry）启动时间与内存随年龄线性增长（文件注释自述"不适合长会话"）。
- 建议：属设计取舍，至少文档化磁盘增长行为；若需长会话保障，compaction 时对 JSONL 做追加式"重写快照"或独立归档文件物化。

**P8. toolcall 参数流逐 delta 对增长中的 JSON 全量解析（O(n²)）**
- 位置：`packages/ai/src/utils/assistant-message-frame.ts:238-262`、`utils/json-parse.ts:104-124`
- 描述：每 `toolcall_delta` 做 `state.catchupJson += delta` 后全量 `parseStreamingJson`（含 `repairJson` 逐字符重建、失败再走 partial-json 双路）+ 深比较。参数累计 N 字符 → O(N²)。工具参数通常较小，实际影响有限，但极端大参数下放大延迟。
- 建议：增量 JSON 解析（记录上次成功解析长度，只喂新增片段），或降频（每 2-3 帧解析一次）。

### 低

**P9. transformMessages 多趟全量处理** — `packages/ai/src/api/transform-messages.ts:64-222`：每次请求 3 趟整表遍历（normalize→transform→结果循环），可合并单趟；`downgradeUnsupportedImages` 对无图模型无条件 map 拷贝。

**P10. `_compactBeforeNextAssistantResponse` 每轮 token 估算 + slice 拷贝** — `packages/coding-agent/src/core/agent-session.ts:538-555`、`packages/ai/src/utils/estimate.ts:114-143`：每轮全量 `estimateContextTokens` 并对 `lastUsageIndex` 后消息 slice+flatMap。O(n) 线性可接受，但与 P6 footer 路径重复计算同一份估算，建议共享缓存。

**P11. grep context>0 时整文件读取并切分** — `packages/coding-agent/src/core/tools/grep.ts:147-160,197-215`：命中文件即使只需前后几行也整文件读入+split（按文件缓存）；匹配数上限 100 但 100 个不同大文件 = 100 次整文件读取。

**P12.（需验证）agent-loop 逐 delta 串行 await 监听者** — `packages/agent/src/agent-loop.ts:315-359`：LLM 流消费速率被最慢监听者（TUI 渲染/扩展 handler）串行拖累；天然背压方向正确，但重活监听者会拖慢 token 消费，需实测定位。

**P13. 每请求 prepareRequest 的 auth/header 合并开销** — `packages/coding-agent/src/core/model-runtime.ts:573-608,113-127`：每请求 `getAuth` 走 provider env 解析 + 多次对象展开/`mergeHeaders` 大小写重查；请求级一次，成本微小。

## 热路径性能概况

- **每轮 LLM 请求**：`transformContext → convertToLlm → transformMessages → estimate`，整体 O(消息数+总字符)，线性无异常。
- **流式过程（最热）**：每 delta 做「帧编码（增量切片，做得好）→ JSONL append（P1 主瓶颈）→ 事件广播（watcher reduce + session 监听器串行 await，P12）」。TUI 侧每 delta 触发组件更新与 footer 全量统计（P6）。
- **工具输出**：harness bash 有 100ms 自适应限流（设计好），但每次发布的全量截断/序列化固定开销仍高（P3、P4）；交互 `!bash` 无节流且 O(n²)（P2）。
- **会话持久化**：追加式 JSONL（好）、commit 串行保序；启动全量重放、长会话无回收（P7）。
- **token 估算/溢出**：overflow 正则一次错误串（~25 正则，可忽略）；估算按轮线性扫描，重复计算多（P6、P10）。

（只读分析，未修改任何文件、未运行任何命令；P6/P12 的量化影响需实测验证。）