import { Type } from "typebox";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import path from "node:path";

// ── 辅助：读 sales.csv 并按条件过滤（与 05a 相同的取数逻辑） ──
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

// ═════════ 方式二：扩展里 pi.registerTool（配合拦截） ═════════
// 扩展工厂：pi.loader 加载时被调用，在这里注册工具、订阅事件
function salesExtension(pi: ExtensionAPI) {
  // ① 注册工具：写法和 defineTool 基本一致，只是调用方变成扩展 API
  pi.registerTool({
    name: "query_data",
    label: "查询销售数据",
    description: "查询销售数据（sales.csv）。按指定列的条件过滤，返回匹配的行。字段：日期、产品、地区、销售额、数量、销售人员。",
    promptSnippet: "Query sales.csv rows by column condition",
    promptGuidelines: [
      "Use query_data when the user asks about sales rows, regions, products, or salespeople in sales.csv.",
    ],
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

  // ② 配套拦截：工具执行前介入，拦掉不合理的调用
  //    返回 { block: true, reason } 会阻止执行，并把 reason 返回给 LLM
  pi.on("tool_call", (event) => {
    console.log(`🛡 [tool_call] ${event.toolName}`);
    if (event.toolName !== "query_data") return;
    const limit = event.input.limit;
    if (typeof limit === "number" && limit > 100) {
      return { block: true, reason: "单次最多返回 100 行，请把 limit 调小后重试" };
    }
  });
}

// ═════════ 注册 + 运行 ═════════
// 配置目录：项目内的 .pi-config（里面放 models.json / auth.json）
const configDir = path.join(process.cwd(), ".pi-config");

// 1. 资源加载器：把扩展工厂塞进去，由它负责「扩展 + 工具」的装配
const resourceLoader = new DefaultResourceLoader({
  cwd: process.cwd(),
  agentDir: configDir,
  extensionFactories: [salesExtension],   // ★ 内联扩展：注册自定义工具
});
await resourceLoader.reload();

// 2. 加载模型配置（models.json + auth.json 都指向项目内，不碰 ~/.pi/agent）
const modelRuntime = await ModelRuntime.create({
  modelsPath: path.join(configDir, "models.json"),
  authPath: path.join(configDir, "auth.json"),
});
const available = await modelRuntime.getAvailable();
const model = available[0];
if (!model) throw new Error("没有可用模型，请检查 ~/.pi/agent/models.json");

// 3. 创建会话：用 resourceLoader 替代 customTools，工具由扩展提供
const { session } = await createAgentSession({
  agentDir: configDir,
  model, modelRuntime,
  resourceLoader,
  sessionManager: SessionManager.inMemory(),
});

// 4. 白名单：只放行 query_data，内置的 read/bash/edit/write 全部对 LLM 隐藏
session.setActiveToolsByName(["query_data"]);

try {
  session.subscribe((event) => {
    if (event.type === "tool_execution_start") console.log(`🔧 调用工具：${event.toolName}`);
    else if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta")
      process.stdout.write(event.assistantMessageEvent.delta);
  });
  console.log("💬 问：华东地区一共多少销售额？\n");
  await session.prompt("华东地区一共多少销售额？");
  console.log("\n");
} finally {
  session.dispose();
}
