import { Type } from "typebox";
import {
  createAgentSession, DefaultResourceLoader, defineTool, ModelRuntime, SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import path from "node:path";

// ── 数据访问：三个工具共用的取数逻辑 ──
function loadSales(): { headers: string[]; rows: Array<Record<string, string>> } {
  const content = readFileSync(join(process.cwd(), "shared/data/sales.csv"), "utf-8");
  const lines = content.trim().split("\n");
  const headers = lines[0].split(",").map((h) => h.trim());
  const rows = lines.slice(1).map((line) => {
    const v = line.split(",").map((x) => x.trim());
    return Object.fromEntries(headers.map((h, i) => [h, v[i] ?? ""])) as Record<string, string>;
  });
  return { headers, rows };
}

function assertColumn(headers: string[], column: string): void {
  if (!headers.includes(column)) {
    throw new Error(`列名 "${column}" 不存在。可用列：${headers.join("、")}`);
  }
}

function querySales(column: string, operator: string, value: string, limit = 20): string {
  const { headers, rows } = loadSales();
  assertColumn(headers, column);

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

function sumSales(groupBy: string, topN = 10): string {
  const { headers, rows } = loadSales();
  assertColumn(headers, groupBy);

  const totals = new Map<string, { sum: number; count: number }>();
  for (const row of rows) {
    const key = row[groupBy];
    const item = totals.get(key) ?? { sum: 0, count: 0 };
    item.sum += Number(row["销售额"]);
    item.count += 1;
    totals.set(key, item);
  }

  const list = [...totals.entries()].sort((a, b) => b[1].sum - a[1].sum).slice(0, topN);
  let text = `按「${groupBy}」汇总销售额（共 ${rows.length} 行）：\n`;
  for (const [key, { sum, count }] of list) text += `${key}：${sum}（${count} 笔）\n`;
  return text;
}

function distinctValues(column: string): string {
  const { headers, rows } = loadSales();
  assertColumn(headers, column);
  const values = [...new Set(rows.map((r) => r[column]))];
  return `列「${column}」共 ${values.length} 个去重值：${values.join("、")}`;
}

// ── 拦截规则类型：guard 是本文件给工具加的字段，框架不感知 ──
type GuardResult = { block: true; reason: string } | undefined;
type ToolGuard = (input: Record<string, unknown>) => GuardResult;
type GuardedTool = ReturnType<typeof defineTool> & { guard?: ToolGuard };

// ═════════ 工具一：条件查询 ═════════
const queryDataTool: GuardedTool = {
  ...defineTool({
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
  }),
  // 拦截规则写在工具定义里：单次最多 100 行
  guard: (input) => {
    const limit = Number(input.limit ?? 20);
    if (Number.isFinite(limit) && limit > 100) {
      return { block: true, reason: "单次最多返回 100 行，请把 limit 调小后重试" };
    }
  },
};

// ═════════ 工具二：分组汇总 ═════════
const sumSalesTool: GuardedTool = {
  ...defineTool({
    name: "sum_sales",
    label: "按维度汇总销售额",
    description: "按指定维度（地区/产品/销售人员/日期）分组汇总销售额，返回销售额最高的前 N 组。",
    promptSnippet: "Group sales.csv rows by a dimension and sum 销售额",
    promptGuidelines: [
      "Use sum_sales when the user asks for totals or rankings grouped by 地区, 产品, 销售人员, or 日期.",
    ],
    parameters: Type.Object({
      groupBy: Type.String({ description: "分组维度列名，如：地区、产品、销售人员、日期" }),
      topN: Type.Optional(Type.Number({ description: "返回销售额最高的前 N 组，默认 10" })),
    }),
    async execute(_id, params) {
      const text = sumSales(params.groupBy, params.topN);
      return { content: [{ type: "text", text }], details: {} };
    },
  }),
  // 拦截规则写在工具定义里：分组最多 20 个
  guard: (input) => {
    const topN = Number(input.topN ?? 10);
    if (Number.isFinite(topN) && topN > 20) {
      return { block: true, reason: "最多返回 20 个分组，请把 topN 调小后重试" };
    }
  },
};

// ═════════ 工具三：列去重值 ═════════
const distinctValuesTool: GuardedTool = {
  ...defineTool({
    name: "distinct_values",
    label: "列去重值",
    description: "列出 sales.csv 指定列的去重值及数量，适合确认地区、产品、销售人员有哪些取值。",
    promptSnippet: "List distinct values of a sales.csv column",
    promptGuidelines: [
      "Use distinct_values when the user asks which regions, products, or salespeople exist in the data.",
    ],
    parameters: Type.Object({
      column: Type.String({ description: "要列出去重值的列名，如：地区、产品、销售人员" }),
    }),
    async execute(_id, params) {
      const text = distinctValues(params.column);
      return { content: [{ type: "text", text }], details: {} };
    },
  }),
  // 拦截规则写在工具定义里：高基数列去重没有意义
  guard: (input) => {
    if (input.column === "销售额") {
      return { block: true, reason: "销售额是高基数列，去重无意义；请改用 sum_sales 或 query_data" };
    }
  },
};

// 所有工具集中在这里，统一注册
const SALES_TOOLS: GuardedTool[] = [queryDataTool, sumSalesTool, distinctValuesTool];

// ═════════ 方式二：扩展里 pi.registerTool（统一注册 + 统一拦截） ═════════
function salesExtension(pi: ExtensionAPI) {
  // ① 统一注册：遍历工具列表，逐个交给 pi.registerTool
  for (const tool of SALES_TOOLS) {
    pi.registerTool(tool);
  }

  // ② 统一拦截：拦不拦由各工具定义里的 guard 决定
  pi.on("tool_call", (event) => {
    console.log(`🛡 [tool_call] ${event.toolName}`);
    const tool = SALES_TOOLS.find((t) => t.name === event.toolName);
    const blocked = tool?.guard?.(event.input as Record<string, unknown>);
    if (blocked) {
      console.log(`⛔ 拦截 ${event.toolName}：${blocked.reason}`);
      return blocked;
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

// 4. 白名单：只放行这三个自定义工具，内置的 read/bash/edit/write 全部隐藏
session.setActiveToolsByName(SALES_TOOLS.map((tool) => tool.name));

try {
  session.subscribe((event) => {
    if (event.type === "tool_execution_start") console.log(`🔧 调用工具：${event.toolName}`);
    else if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta")
      process.stdout.write(event.assistantMessageEvent.delta);
  });
  const question = "华东地区一共多少销售额？再按产品汇总一下，列出所有销售人员，顺便列一下销售额的去重值。";
  console.log(`💬 问：${question}\n`);
  await session.prompt(question);
  console.log("\n");
} finally {
  session.dispose();
}
