import path from "node:path";
import {
    createAgentSession,
    DefaultResourceLoader,   // 资源加载器：管提示词、技能、扩展等资源的加载
    getAgentDir,             // 返回全局配置目录 ~/.pi/agent
    ModelRuntime,
    SessionManager,          // 会话管理器：管对话历史的存取
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

const loader = new DefaultResourceLoader({
    cwd: process.cwd(),          // 当前工作目录
    agentDir: configDir,     // 全局配置目录
    // ★ 换基础人设：返回什么，人设就是什么（忽略 base，彻底替换）
    systemPromptOverride: () => `你是一个企业数据分析助手，帮业务方分析销售数据、定位问题、给出建议。
回答前先确认已知信息和未知信息，不要编造数据。`,
    // ★ 清空追加规则（②），剔除 .pi/APPEND_SYSTEM.md 文件的内容（如果有的话）
    appendSystemPromptOverride: () => [],
});
await loader.reload();   // 重新加载资源（让上面的覆盖生效）

const { session } = await createAgentSession({
    model,
    modelRuntime,
    resourceLoader: loader,              // ★ 把自定义 Loader 传进去
    sessionManager: SessionManager.inMemory(),  // 用内存会话，调试不污染目录
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

    console.log("💬 问：上月销售额下降了 15%，可能的原因有哪些？\n");
    await session.prompt("上月销售额下降了 15%，可能的原因有哪些？");
    console.log("\n");
} finally {
    session.dispose();
}