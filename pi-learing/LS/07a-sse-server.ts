import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import path from "node:path";
import { Type } from "typebox";
import {
  createAgentSession, DefaultResourceLoader, defineTool, ModelRuntime, SessionManager,
} from "@earendil-works/pi-coding-agent";

// ═════════ 工具：query_data（数据查询，细节同 05a） ═════════
function querySales(column: string, operator: string, value: string, limit = 20): string {
  const content = readFileSync(join(process.cwd(), "shared/data/sales.csv"), "utf-8");
  const lines = content.trim().split("\n");
  const headers = lines[0].split(",").map((h) => h.trim());
  const rows = lines.slice(1).map((line) => {
    const v = line.split(",").map((x) => x.trim());
    return Object.fromEntries(headers.map((h, i) => [h, v[i] ?? ""])) as Record<string, string>;
  });

  if (!headers.includes(column)) {
    throw new Error(`列名 "${column}" 不存在。可用列：${headers.join("、")}`);
  }

  const num = (s: string) => Number(s);
  const matched = rows.filter((r) => {
    const cell = r[column];
    switch (operator) {
      case "=": return cell === value;
      case "!=": return cell !== value;
      case ">": return num(cell) > num(value);
      case "<": return num(cell) < num(value);
      case ">=": return num(cell) >= num(value);
      case "<=": return num(cell) <= num(value);
      case "contains": return cell.includes(value);
      default: return false;
    }
  });

  const shown = matched.slice(0, limit);
  let text = `查询条件：${column} ${operator} ${value}\n匹配 ${matched.length}/${rows.length} 行\n\n`;
  text += headers.join(", ") + "\n";
  for (const r of shown) text += headers.map((h) => r[h]).join(", ") + "\n";
  return text;
}

const queryDataTool = defineTool({
  name: "query_data",
  label: "查询销售数据",
  description: "查询销售数据（sales.csv）。按指定列的条件过滤，返回匹配的行。字段：日期、产品、地区、销售额、数量、销售人员。",
  parameters: Type.Object({
    column: Type.String({ description: "要过滤的列名，如：地区、产品、销售人员、销售额" }),
    operator: Type.Union(
      [Type.Literal("="), Type.Literal("!="), Type.Literal(">"), Type.Literal("<"),
      Type.Literal(">="), Type.Literal("<="), Type.Literal("contains")],
      { description: "比较运算符：= != > < >= <= contains" },
    ),
    value: Type.String({ description: "过滤条件的值" }),
    limit: Type.Optional(Type.Number({ description: "最多返回行数，默认 20" })),
  }),
  async execute(_id, params) {
    const text = querySales(params.column, params.operator, params.value, params.limit);
    return { content: [{ type: "text", text }], details: {} };
  },
});

// ═════════ 第 1 步：组装 Agent，拿到 session ═════════
const configDir = path.join(process.cwd(), ".pi-config");

const loader = new DefaultResourceLoader({
  cwd: process.cwd(),
  agentDir: configDir,
  systemPromptOverride: () =>
    "你是企业数据分析助手。回答必须基于 query_data 工具查到的真实销售数据，不要编造数字。用中文，结论先行，必要时给出明细。",
  extensionFactories: [(pi) => { pi.registerTool(queryDataTool); }],
});
await loader.reload();

const modelRuntime = await ModelRuntime.create({
  modelsPath: path.join(configDir, "models.json"),
  authPath: path.join(configDir, "auth.json"),
});
const model = (await modelRuntime.getAvailable())[0];
if (!model) throw new Error("没有可用模型，请检查 ~/.pi/agent/models.json");

const { session } = await createAgentSession({
  agentDir: configDir,
  model, modelRuntime,
  resourceLoader: loader,
  sessionManager: SessionManager.inMemory(),
});
// 垂直智能体：只放行 query_data
session.setActiveToolsByName(["query_data"]);

// ═════════ SSE 工具函数 ═════════
function sse(type: string, data: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

// subscribe 事件的最小形状（只声明用到的字段）
interface SubscribedEvent {
  type: string;
  assistantMessageEvent?: { type?: string; delta?: string };
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  isError?: boolean;
  result?: { content?: Array<{ type: string; text?: string }> };
}

function extractText(result: SubscribedEvent["result"]): string {
  const blocks = result?.content;
  if (!Array.isArray(blocks)) return "";
  return blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
}

// 把 subscribe 事件翻译成前端要的 SSE 格式，不认识的事件返回 null
function translateEvent(event: SubscribedEvent): string | null {
  if (event.type === "message_update") {
    const sub = event.assistantMessageEvent;
    if (sub?.type === "text_delta") return sse("text", { delta: sub.delta });
    if (sub?.type === "thinking_delta") return sse("thinking", { delta: sub.delta });
    return null;
  }
  if (event.type === "tool_execution_start") {
    return sse("tool_start", { id: event.toolCallId, name: event.toolName, args: event.args });
  }
  if (event.type === "tool_execution_end") {
    return sse("tool_end", {
      id: event.toolCallId,
      name: event.toolName,
      isError: event.isError ?? false,
      result: extractText(event.result),
    });
  }
  return null;
}

// ═════════ 第 2 步：POST /chat，用 session 干三件事 ═════════
let busy = false; // 单用户防并发

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf-8");
  return raw ? JSON.parse(raw) : {};
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

async function handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = (await readBody(req)) as { message?: unknown };
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) {
    sendJson(res, 400, { error: "message 不能为空" });
    return;
  }
  if (busy) {
    sendJson(res, 429, { error: "Agent 正忙，稍等" });
    return;
  }
  busy = true;

  // SSE 响应头
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();

  let settled = false;
  let aborted = false;

  // ① 收事件：Agent 处理时不断产生事件，翻译后推给浏览器
  const off = session.subscribe((event) => {
    const payload = translateEvent(event as unknown as SubscribedEvent);
    if (payload) res.write(payload);
  });

  // ② 打断：浏览器断开连接时中止 Agent
  req.on("close", () => {
    if (settled) return;
    aborted = true;
    void session.abort();
  });

  // ③ 发消息：触发 Agent 处理
  try {
    await session.prompt(message);
  } catch (error) {
    if (!aborted) {
      res.write(sse("error", { message: error instanceof Error ? error.message : String(error) }));
    }
  } finally {
    settled = true;
    off();
    if (!aborted) {
      res.write(sse("done", {}));
      res.end();
    }
    busy = false;
  }
}

// ═════════ 第 3 步：前端页面（内嵌，免装 express/静态目录） ═════════
const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>DataAgent</title>
<style>
  body { font: 14px/1.6 system-ui, sans-serif; background: #1e1f22; color: #ddd; margin: 0; }
  main { max-width: 760px; margin: 0 auto; padding: 24px; }
  h1 { font-size: 18px; }
  #log { display: flex; flex-direction: column; gap: 8px; min-height: 240px; margin: 16px 0; }
  .bubble { padding: 8px 12px; border-radius: 8px; white-space: pre-wrap; word-break: break-word; }
  .user { align-self: flex-end; background: #2d4f3a; }
  .assistant { align-self: flex-start; background: #2b2d31; }
  .tool { align-self: flex-start; background: #33302a; color: #d2b48c; font-size: 12px; }
  .error { align-self: stretch; background: #4a2323; color: #ffb4b4; }
  .row { display: flex; gap: 8px; }
  textarea { flex: 1; height: 56px; background: #2b2d31; color: #ddd; border: 1px solid #444; border-radius: 6px; padding: 8px; }
  button { width: 88px; background: #3b6ef5; color: #fff; border: 0; border-radius: 6px; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
</style>
</head>
<body>
<main>
  <h1>DataAgent（SSE 流式对话）</h1>
  <div id="log"></div>
  <div class="row">
    <textarea id="msg" placeholder="例如：华东地区笔记本卖了多少？（Ctrl+Enter 发送）"></textarea>
    <button id="send">发送</button>
  </div>
</main>
<script>
const logEl = document.getElementById("log");
const inputEl = document.getElementById("msg");
const btn = document.getElementById("send");
let textEl = null;

function addBubble(cls, text) {
  const div = document.createElement("div");
  div.className = "bubble " + cls;
  if (text) div.textContent = text;
  logEl.appendChild(div);
  return div;
}

async function send() {
  const message = inputEl.value.trim();
  if (!message || btn.disabled) return;
  inputEl.value = "";
  addBubble("user", message);
  textEl = null;
  btn.disabled = true;
  try {
    const res = await fetch("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: message }),
    });
    if (!res.ok || !res.body) {
      const err = await res.json().catch(function () { return { error: "请求失败" }; });
      addBubble("error", err.error || "请求失败");
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let idx = buffer.indexOf("\\n\\n");
      while (idx >= 0) {
        handleEvent(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 2);
        idx = buffer.indexOf("\\n\\n");
      }
    }
  } catch (err) {
    addBubble("error", "连接中断：" + err.message);
  } finally {
    btn.disabled = false;
  }
}

function handleEvent(raw) {
  let type = "message";
  const dataLines = [];
  for (const line of raw.split("\\n")) {
    if (line.startsWith("event:")) type = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  let data = {};
  try { data = dataLines.length ? JSON.parse(dataLines.join("\\n")) : {}; } catch (e) { data = {}; }

  if (type === "text") {
    if (!textEl) textEl = addBubble("assistant");
    textEl.textContent += data.delta;
  } else if (type === "thinking") {
    // 思考过程：这里省略，可折叠展示
  } else if (type === "tool_start") {
    addBubble("tool", "调用工具 " + data.name + " " + JSON.stringify(data.args));
  } else if (type === "tool_end") {
    addBubble("tool", "工具 " + data.name + (data.isError ? " 失败：" : " 完成：") + (data.result || ""));
  } else if (type === "error") {
    addBubble("error", data.message || "出错了");
  }
}

btn.addEventListener("click", send);
inputEl.addEventListener("keydown", function (e) {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) send();
});
</script>
</body>
</html>`;

// ═════════ HTTP 服务 ═════════
const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(PAGE);
    return;
  }

  if (req.method === "POST" && url.pathname === "/chat") {
    void handleChat(req, res);
    return;
  }

  sendJson(res, 404, { error: "Not Found" });
});

server.listen(3000, () => {
  console.log("→ http://localhost:3000");
});
