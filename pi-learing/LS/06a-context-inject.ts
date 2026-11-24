import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import path from "node:path";

// ── 当前登录用户（真实项目里从 token / SSO / 会话上下文解析） ──
const CURRENT_USER = {
  name: "张三",
  department: "销售一部",
  role: "销售主管",
  permissions: ["sales:read", "sales:write"],
  preferences: ["回答用中文", "金额带千分位", "先给结论再给细节"],
};

// 拼成一段有边界的上下文文本，避免和用户问题混在一起
function buildUserContext(): string {
  return [
    "<user_context>",
    `姓名：${CURRENT_USER.name}`,
    `部门：${CURRENT_USER.department}`,
    `角色：${CURRENT_USER.role}`,
    `权限：${CURRENT_USER.permissions.join("、") || "无"}`,
    `偏好：${CURRENT_USER.preferences.join("；")}`,
    "要求：缺少对应权限的操作一律拒绝，并提示用户申请权限。",
    "</user_context>",
  ].join("\n");
}

// ═════════ 扩展：监听 context 事件，注入用户上下文 ═════════
function userContextExtension(pi: ExtensionAPI) {
  // context 在每次调用 LLM 前触发。
  // 注意：这里返回的 messages 只用于本次请求，不会写回会话历史，
  // 所以每次调用都要重新注入，不会在历史里越积越多。
  pi.on("context", (event) => {
    const injected = {
      role: "user" as const,
      content: buildUserContext(),
      timestamp: Date.now(),
    };

    console.log(`[context] 注入用户上下文（当前历史 ${event.messages.length} 条）`);

    // 放在最前面，作为本轮对话的背景信息
    return { messages: [injected, ...event.messages] };
  });
}

// ═════════ 注册 + 运行 ═════════
const configDir = path.join(process.cwd(), ".pi-config");

const resourceLoader = new DefaultResourceLoader({
  cwd: process.cwd(),
  agentDir: configDir,
  extensionFactories: [userContextExtension],
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

// 纯上下文演示，不需要工具：白名单置空，LLM 退化成纯文本对话
session.setActiveToolsByName([]);

try {
  session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta")
      process.stdout.write(event.assistantMessageEvent.delta);
  });
  const question = "我是谁？属于哪个部门？有哪些权限？哪些事情我不能做？";
  console.log(`问：${question}\n`);
  await session.prompt(question);
  console.log("\n");
} finally {
  session.dispose();
}
