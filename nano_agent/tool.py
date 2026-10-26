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
from typing import Callable

logger = logging.getLogger(__name__)


class Tool:
    """A callable the model can invoke; name/description/schema drive the prompt."""

    def __init__(self, name: str, description: str, parameters: dict, fn: Callable[..., str]):
        self.name = name
        self.description = description
        self.parameters = parameters
        self.fn = fn

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


def run_tool_calls(tools: dict[str, Tool], calls: list[dict]) -> list[dict]:
    """Execute model `tool_calls` against a {name: Tool} map.

    Returns the list of `role: tool` messages to append to the conversation.
    Unknown tool names produce an error message so the model can recover.
    """
    messages = []
    logger.info("run_tool_calls: executing %d model tool call(s)", len(calls))
    for call in calls:
        fn = call["function"]
        tool = tools.get(fn["name"])
        if tool is None:
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
            result = tool.run(arguments)
            logger.info(
                "run_tool_calls: call id=%s tool [%s] result=%s",
                call.get("id"), tool.name, result,
            )
        messages.append({"role": "tool", "tool_call_id": call["id"], "content": result})
    logger.info("run_tool_calls: done, %d message(s) produced", len(messages))
    return messages