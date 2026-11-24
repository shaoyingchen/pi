import { Type } from "typebox";
import {
  createAgentSession, DefaultResourceLoader, defineTool, ModelRuntime, SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import path from "node:path";
import { createInterface } from "node:readline/promises";

// ── 数据访问 ──
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

// ═════════ 工具：删除销售记录（危险操作，执行前需要用户确认） ═════════
const deleteRowsTool = defineTool({
  name: "delete_sales_rows",
  label: "删除销售记录",
  description: "按单列等值条件删除销售记录。危险操作：执行前会要求用户确认。",
  promptSnippet: "Delete sales.csv rows by a column value (requires user confirmation)",
  promptGuidelines: [
    "Use delete_sales_rows only when the user explicitly asks to delete sales records.",
  ],
  parameters: Type.Object({
    column: Type.String({ description: "过滤列名，如：地区、产品、销售人员" }),
    value: Type.String({ description: "要删除的记录在该列上的取值" }),
  }),
  async execute(_id, params) {
    const { headers, rows } = loadSales();
    assertColumn(headers, params.column);
    const remaining = rows.filter((r) => r[params.column] !== params.value);
    const deleted = rows.length - remaining.length;
    return {
      content: [{
        type: "text",
        text: `已删除 ${deleted} 条「${params.column}=${params.value}」的记录（演示，不实际写文件），剩余 ${remaining.length} 条。`,
      }],
      details: {},
    };
  },
});

// ═════════ 扩展：注册工具 + 执行前确认 ═════════
function confirmExtension(pi: ExtensionAPI) {
  pi.registerTool(deleteRowsTool);

  // tool_call 在 execute 之前触发：这里问用户，用户拒绝就 block 掉这次调用
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "delete_sales_rows") return;

    const input = event.input as Record<string, unknown>;
    const ok = await ctx.ui.confirm(
      "危险操作确认",
      `即将删除「${input.column}=${input.value}」的销售记录，此操作不可撤销。是否继续？`,
    );

    if (!ok) {
      return { block: true, reason: "用户拒绝执行删除操作，请告知用户已取消" };
    }
  });
}

// ═════════ 终端确认框 ═════════
// SDK 默认没有交互 UI，ctx.ui.confirm 会恒返回 false（内置 noop UI）。
// 这里用 readline 实现一个最小 UI，再通过 session.bindExtensions 接入。
function createTerminalUIContext() {
  return {
    async confirm(title: string, message: string) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = await rl.question(`\n${title}\n${message}\n继续执行？(y/N) `);
        return /^y(es)?$/i.test(answer.trim());
      } finally {
        rl.close();
      }
    },
    notify(message: string) {
      console.log(`[notify] ${message}`);
    },
  } as unknown as ExtensionUIContext;
}

// ═════════ 注册 + 运行 ═════════
// 配置目录：项目内的 .pi-config（里面放 models.json / auth.json）
const configDir = path.join(process.cwd(), ".pi-config");

const resourceLoader = new DefaultResourceLoader({
  cwd: process.cwd(),
  agentDir: configDir,
  extensionFactories: [confirmExtension],
});
await resourceLoader.reload();

const modelRuntime = await ModelRuntime.create({
  modelsPath: path.join(configDir, "models.json"),
  authPath: path.join(configDir, "auth.json"),
});
const available = await modelRuntime.getAvailable();
const model = available[0];
if (!model) throw new Error("没有可用模型，请检查 ~/.pi/agent/models.json");

const { session } = await createAgentSession({
  agentDir: configDir,
  model, modelRuntime,
  resourceLoader,
  sessionManager: SessionManager.inMemory(),
});

// 接入终端确认框，再收窄工具
await session.bindExtensions({ uiContext: createTerminalUIContext() });
session.setActiveToolsByName(["delete_sales_rows"]);

try {
  session.subscribe((event) => {
    if (event.type === "tool_execution_start") console.log(`[tool] 调用工具：${event.toolName}`);
    else if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta")
      process.stdout.write(event.assistantMessageEvent.delta);
  });
  const question = "把华北地区的销售记录都删掉。";
  console.log(`问：${question}\n`);
  await session.prompt(question);
  console.log("\n");
} finally {
  session.dispose();
}
