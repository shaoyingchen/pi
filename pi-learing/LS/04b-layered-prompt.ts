import { readFile } from "fs/promises";
import { join } from "path";
import path from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

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

// ★ 静态部分：启动时一次性读到内存（运营改文件后重启生效）
const PROMPTS_DIR = join(configDir, "prompts", "analyst");
// Promise.all：让三个读文件操作并行执行，全部完成后再一起往下走
// 左边 [persona, rules, outputFormat] 是「解构赋值」：把返回的数组按顺序拆成三个变量
const [persona, rules, outputFormat] = await Promise.all([
  readFile(join(PROMPTS_DIR, "persona.md"), "utf-8"),
  readFile(join(PROMPTS_DIR, "rules.md"), "utf-8"),
  readFile(join(PROMPTS_DIR, "output-format.md"), "utf-8"),
]);

// ★ 动态部分：每次请求从"数据库"读用户上下文
async function getUserContext(userId: string) {
  // 下面 Record<string, {...}> 是 TS 的「字典类型」标注：表示 users 是个对象，
  // 键是字符串（如 "u001"），值是 { name, department, role, dataScope } 这种结构。
  // 看不懂没关系——它只给编辑器看，运行时就是个普通 JS 对象。
  const users: Record<string, { name: string; department: string; role: string; dataScope: string }> = {
    "u001": { name: "王小姐", department: "销售部", role: "销售经理", dataScope: "本部门销售数据" },
    "u002": { name: "李先生", department: "财务部", role: "财务分析师", dataScope: "全公司财务数据" },
  };
  return users[userId] ?? { name: "未知用户", department: "未知", role: "访客", dataScope: "无" };
}

// 模拟一次请求：用户 u001 登录后问问题
const userId = "u001";
const userContext = await getUserContext(userId);

// ★ 拼装：静态文件 + 动态用户上下文
const fullPrompt = [
  persona,
  `## 当前用户上下文
姓名：${userContext.name}
部门：${userContext.department}
角色：${userContext.role}
数据权限范围：${userContext.dataScope}
（回答时只涉及该用户有权访问的数据范围）`,
  rules,
  outputFormat,
].join("\n\n");

const loader = new DefaultResourceLoader({
  cwd: process.cwd(),
  agentDir: configDir,
  systemPromptOverride: () => fullPrompt,
  appendSystemPromptOverride: () => [],
});
await loader.reload();

const { session } = await createAgentSession({
  model,
  modelRuntime,
  resourceLoader: loader,
  sessionManager: SessionManager.inMemory(),
});

try {
  session.subscribe((event) => {
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      process.stdout.write(event.assistantMessageEvent.delta);
    }
  });

  console.log(`💬 用户 ${userContext.name}（${userContext.department}）问：上月销售额下降 15%，可能的原因有哪些？\n`);
  await session.prompt("上月销售额下降了 15%，可能的原因有哪些？");
  console.log("\n");
} finally {
  session.dispose();
}