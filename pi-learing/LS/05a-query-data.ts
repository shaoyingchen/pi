import { Type } from "typebox";
import {
  createAgentSession, defineTool, ModelRuntime, SessionManager,
} from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import path from "node:path";

// ── 辅助：读 sales.csv 并按条件过滤 ──
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

// ═════════ ① 说明书 + ② 干活：定义 query_data 工具 ═════════
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

  // ② 干活：params 已被框架校验好，直接取用
  async execute(_id, params) {
    const text = querySales(params.column, params.operator, params.value, params.limit);
    return { content: [{ type: "text", text }], details: {} };
  },
});

// ═════════ ③ 注册 + 运行 ═════════
// 配置目录：项目内的 .pi-config（里面放 models.json / auth.json）
const configDir = path.join(process.cwd(), ".pi-config");
// 1. 加载配置。默认会去读 ~/.pi/agent/，这里显式指向项目内，避免找不到模型配置
//    await 是因为「读文件」是异步操作，得等它读完才能往下走
const modelRuntime = await ModelRuntime.create({
  modelsPath: path.join(configDir, "models.json"),
});
// 2. 拿到「配了 Key、真正能用」的模型列表
const available = await modelRuntime.getAvailable();
const model = available[0];   // 取列表里第一个能用的
if (!model) throw new Error("没有可用模型，请检查 ~/.pi/agent/models.json");

const { session } = await createAgentSession({
  model, modelRuntime,
  customTools: [queryDataTool],     // ★ 注入自定义工具
  sessionManager: SessionManager.inMemory(),
});

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