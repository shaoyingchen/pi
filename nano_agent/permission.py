"""工具调用的人工审批实现：在终端询问用户是否放行一次工具调用。

配合 ``nano_agent.tool.ToolPolicy`` 使用，策略决定哪些工具需要 ``ask``，
本模块负责把 ``ask`` 变成真实的用户交互::

    from nano_agent import Agent, ToolPolicy, ALLOW, ASK
    from nano_agent.permission import ConsoleApprover

    agent = Agent(
        tools=[make_read_file_tool()],
        approver=ConsoleApprover(),
        policy=ToolPolicy(default=ASK, rules={"read_file": ALLOW}),
    )
"""

from __future__ import annotations

import logging
from typing import Callable

try:
    from .tool import ApprovalDecision, Tool      # 包内引用（from nano_agent import ...）
except ImportError:
    from tool import ApprovalDecision, Tool        # 脚本方式引用（python agent.py）

logger = logging.getLogger(__name__)

DEFAULT_PROMPT = ("允许执行工具 [{name}]?\n参数: {arguments}\n"
                  "输入 y=允许 / a=本次会话全部允许 / n=拒绝: ")
RETRY_PROMPT = "无效输入 {answer!r}，请输入 y / a / n: "


class ConsoleApprover:
    """在终端逐次确认工具调用。

    ``y`` 放行本次，``a`` 放行本次会话内所有后续调用，``n``/空输入/EOF 拒绝。
    无效输入会重新询问，最多 ``max_retries`` 次后按拒绝处理。
    ``input_fn`` 可替换以便测试或接入其他交互通道。
    """

    def __init__(self, prompt: str = DEFAULT_PROMPT,
                 input_fn: Callable[[str], str] = input,
                 max_retries: int = 3):
        self.prompt = prompt
        self.input_fn = input_fn
        self.max_retries = max(1, max_retries)
        self.allow_all = False

    def __call__(self, tool: Tool, arguments: dict) -> ApprovalDecision:
        if self.allow_all:
            logger.info("console approver: tool [%s] auto-approved (allow_all)", tool.name)
            return ApprovalDecision(True, "approved for the rest of the session")

        text = self.prompt.format(name=tool.name, arguments=arguments)
        for _ in range(self.max_retries):
            try:
                answer = self.input_fn(text).strip().lower()
            except (EOFError, KeyboardInterrupt):
                logger.warning("console approver: input aborted, tool [%s] denied", tool.name)
                return ApprovalDecision(False, "approval aborted by user")
            if answer == "y":
                logger.info("console approver: tool [%s] approved", tool.name)
                return ApprovalDecision(True, "approved by user")
            if answer == "a":
                self.allow_all = True
                logger.info("console approver: tool [%s] approved, allow_all enabled", tool.name)
                return ApprovalDecision(True, "approved for the rest of the session")
            if answer in ("n", ""):
                logger.info("console approver: tool [%s] rejected", tool.name)
                return ApprovalDecision(False, "rejected by user")
            text = RETRY_PROMPT.format(answer=answer)

        logger.warning("console approver: no valid input after %d attempt(s), tool [%s] denied",
                       self.max_retries, tool.name)
        return ApprovalDecision(False, "no valid approval input")
