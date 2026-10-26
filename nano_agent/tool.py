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
from typing import Callable


class Tool:
    """A callable the model can invoke; name/description/schema drive the prompt."""

    def __init__(self, name: str, description: str, parameters: dict, fn: Callable[..., str]):
        self.name = name
        self.description = description
        self.parameters = parameters
        self.fn = fn

    def run(self, arguments: dict) -> str:
        try:
            return str(self.fn(**arguments))
        except Exception as exc:                    # report tool errors back to the model
            return f"tool error: {exc}"

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
    for call in calls:
        fn = call["function"]
        tool = tools.get(fn["name"])
        result = tool.run(json.loads(fn.get("arguments") or "{}")) if tool \
            else f"unknown tool: {fn['name']}"
        messages.append({"role": "tool", "tool_call_id": call["id"], "content": result})
    return messages