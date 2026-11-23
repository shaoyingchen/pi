import path from "node:path";
import { createAgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
//     ↑ 从 SDK 里「导入」要用的两个工具，就像 JS 里 require

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

if (!model) {
    console.error("❌ 没找到可用模型，请检查 ~/.pi/agent/models.json");
    process.exit(1);
}

// 3. 创建 Agent 会话
//    createAgentSession() 会返回一个对象，里面有好几个字段；
//    这里用 { session } 这种「解构赋值」写法，只把 session 字段挑出来用
const { session } = await createAgentSession({
    agentDir: configDir, // 指向项目内
    model, modelRuntime
});

try {
    // 4. 订阅事件：Agent 每生成一小段文字，就推一个事件过来
    //    这里只关心「文字增量」这一种事件，收到就立刻打印出来
    session.subscribe((event) => {
        if (
            event.type === "message_update" &&                // 是「消息更新」类事件
            event.assistantMessageEvent.type === "text_delta"  // 而且是「文字增量」子类型
        ) {
            // 用 process.stdout.write 而不是 console.log，是为了不换行，
            // 让文字一段段拼出来（流式打字机效果）
            process.stdout.write(event.assistantMessageEvent.delta);
        }
    });

    console.log(`🤖 使用模型：${model.provider}/${model.id}\n`);
    await session.prompt("用一句话介绍你自己。");   // 发问，等 Agent 答完才继续
    console.log("\n");
} finally {
    session.dispose();   // 释放资源（关监听、断连接）。用 try/finally 包起来，保证出错也能清理
}