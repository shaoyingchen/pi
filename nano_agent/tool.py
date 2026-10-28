"""Common tool module for OpenAI-compatible agents.

Provides the `Tool` abstraction: a named callable whose JSON schema is sent to
the model as a function spec, plus the runner that turns model `tool_calls`
back into `role: tool` messages.

Reuse from any agent in this repo:

    from .tool import Tool, run_tool_calls    # package context (from nano_agent import ...)
    from tool import Tool, run_tool_calls     # plain-script context (python agent.py)
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Callable

logger = logging.getLogger(__name__)


@dataclass
class ApprovalDecision:
    """Human-in-the-loop verdict for a tool call pending approval."""

    approved: bool
    reason: str = ""


class Tool:
    """A callable the model can invoke; name/description/schema drive the prompt.

    Set ``requires_approval=True`` to route every invocation of this tool
    through the agent's approver (Human-in-the-loop) before execution.
    """

    def __init__(self, name: str, description: str, parameters: dict, fn: Callable[..., str],
                 requires_approval: bool = False):
        self.name = name
        self.description = description
        self.parameters = parameters
        self.fn = fn
        self.requires_approval = requires_approval

    def run(self, arguments: dict) -> str:
        logger.info("tool [%s] call begin, arguments: %s", self.name, arguments)
        try:
            result = str(self.fn(**arguments))
        except Exception as exc:
            logger.error("tool [%s] call failed: %s", self.name, exc, exc_info=True)
            return f"tool error: {exc}"
        logger.info("tool [%s] call ok, result: %s", self.name, result)
        return result

    def schema(self) -> dict:
        return {"type": "function",
                "function": {"name": self.name, "description": self.description,
                             "parameters": self.parameters}}


def run_tool_calls(tools: dict[str, Tool], calls: list[dict],
                   approver: Callable[[Tool, dict], ApprovalDecision] | None = None) -> list[dict]:
    """Execute model `tool_calls` against a {name: Tool} map.

    Returns the list of `role: tool` messages to append to the conversation.
    Unknown tool names produce an error message so the model can recover.

    Human-in-the-loop: when ``approver`` is provided, every call to a tool
    with ``requires_approval=True`` and all calls to unknowns (treated as
    dangerous) are routed through ``approver(tool, arguments) -> ApprovalDecision``
    first. Rejected calls are NOT executed; the reason is returned as the tool
    result so the model can replan. Tools without ``requires_approval`` run
    immediately. When ``approver`` is ``None`` but a tool requires approval,
    the call is rejected with a safe default.
    """
    messages = []
    logger.info("run_tool_calls: executing %d model tool call(s)", len(calls))
    for call in calls:
        fn = call["function"]
        tool = tools.get(fn["name"])
        result: str
        if tool is None:
            if approver is not None and not approver(None, {"name": fn["name"]}).approved:
                result = f"unknown tool blocked by approval: {fn['name']}"
                logger.warning(
                    "run_tool_calls: call id=%s unknown tool %r blocked by approver",
                    call.get("id"), fn["name"],
                )
            else:
                result = f"unknown tool: {fn['name']}"
                logger.warning(
                    "run_tool_calls: unknown tool %r (call id=%s), result=%s",
                    fn["name"], call.get("id"), result,
                )
        else:
            arguments = json.loads(fn.get("arguments") or "{}")
            logger.info(
                "run_tool_calls: call id=%s -> tool [%s], arguments=%s",
                call.get("id"), tool.name, arguments,
            )
            if tool.requires_approval:
                decision = approver(tool, arguments) if approver is not None else ApprovalDecision(False)
                if not decision.approved:
                    result = f"tool call rejected by user: {tool.name} ({decision.reason})"
                    logger.info(
                        "run_tool_calls: call id=%s tool [%s] rejected by user: %s",
                        call.get("id"), tool.name, decision.reason,
                    )
                    messages.append({"role": "tool", "tool_call_id": call["id"], "content": result})
                    continue
            result = tool.run(arguments)
            logger.info(
                "run_tool_calls: call id=%s tool [%s] result=%s",
                call.get("id"), tool.name, result,
            )
        messages.append({"role": "tool", "tool_call_id": call["id"], "content": result})
    logger.info("run_tool_calls: done, %d message(s) produced", len(messages))
    return messages