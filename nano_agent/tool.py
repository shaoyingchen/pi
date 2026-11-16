"""Common tool module for OpenAI-compatible agents.

Provides the `Tool` abstraction: a named callable whose JSON schema is sent to
the model as a function spec, plus the runner that turns model `tool_calls`
back into `role: tool` messages.

Reuse from any agent in this repo:

    from .tool import Tool, run_tool_calls    # package context (from nano_agent import ...)
    from tool import Tool, run_tool_calls     # plain-script context (python agent.py)

Tool permission model (``ToolPolicy`` + ``run_tool_calls``):

* every call is resolved to a level -- ``allow`` / ``ask`` / ``deny``;
* an explicit rule in ``ToolPolicy.rules`` wins;
* otherwise ``Tool.requires_approval`` decides (``True`` -> ask, ``False`` -> policy default);
* unknown tool names (model hallucination) are always denied.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import Callable

logger = logging.getLogger(__name__)

ALLOW = "allow"
ASK = "ask"
DENY = "deny"
_LEVELS = (ALLOW, ASK, DENY)


@dataclass
class ApprovalDecision:
    """Human-in-the-loop verdict for a tool call pending approval."""

    approved: bool
    reason: str = ""


@dataclass
class ToolPolicy:
    """Per-tool permission policy consulted by ``run_tool_calls``.

    ``default``: level for tools without an explicit rule (default ``allow``,
    which keeps plain ``Agent(tools=[...])`` behaviour unchanged).
    ``rules``: ``{tool name: level}`` overrides both ``default`` and
    ``Tool.requires_approval``.
    """

    default: str = ALLOW
    rules: dict[str, str] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.default not in _LEVELS:
            raise ValueError(f"invalid policy default {self.default!r}, expected one of {_LEVELS}")
        invalid = {name: level for name, level in self.rules.items() if level not in _LEVELS}
        if invalid:
            raise ValueError(f"invalid policy level(s) {invalid}, expected one of {_LEVELS}")

    def level_for(self, tool: "Tool | None", name: str) -> str:
        """Resolve the level for one call; unknown tool names are always denied."""
        if tool is None:
            return DENY
        if name in self.rules:
            return self.rules[name]
        if tool.requires_approval:
            return ASK
        return self.default


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


def _parse_arguments(raw: object) -> dict:
    """Parse a model-provided ``arguments`` payload into a dict; raises ValueError."""
    arguments = json.loads(raw or "{}")
    if not isinstance(arguments, dict):
        raise ValueError(f"arguments must be a JSON object, got {type(arguments).__name__}")
    return arguments


def run_tool_calls(tools: dict[str, Tool], calls: list[dict],
                   approver: Callable[[Tool, dict], ApprovalDecision] | None = None,
                   policy: ToolPolicy | None = None) -> list[dict]:
    """Execute model `tool_calls` against a {name: Tool} map.

    Returns the list of `role: tool` messages to append to the conversation.
    Unknown tool names produce an error message so the model can recover.

    Permission: each call is resolved through ``policy`` (default
    ``ToolPolicy()``, i.e. allow unless a tool sets ``requires_approval``).
    ``deny`` blocks the call, ``ask`` routes it through
    ``approver(tool, arguments) -> ApprovalDecision``, and ``allow`` runs it
    immediately. Rejected or denied calls are NOT executed; the reason is
    returned as the tool result so the model can replan. An ``ask`` without an
    ``approver`` is rejected with a safe default.
    """
    policy = policy or ToolPolicy()
    messages = []
    logger.info("run_tool_calls: executing %d model tool call(s), policy default=%s",
                len(calls), policy.default)
    for call in calls:
        call_id = call.get("id")
        fn = call.get("function") or {}
        name = fn.get("name") or ""
        tool = tools.get(name)
        level = policy.level_for(tool, name)

        arguments: dict = {}
        if tool is not None:
            try:
                arguments = _parse_arguments(fn.get("arguments"))
            except (json.JSONDecodeError, ValueError) as exc:
                result = f"tool call error: invalid arguments for {name}: {exc}"
                logger.warning(
                    "run_tool_calls: call id=%s invalid arguments for tool [%s]: %s, raw=%r",
                    call_id, name, exc, fn.get("arguments"),
                )
                messages.append({"role": "tool", "tool_call_id": call_id, "content": result})
                continue

        if level == DENY:
            result = (f"unknown tool blocked by policy: {name}" if tool is None
                      else f"tool call denied by policy: {name}")
            logger.warning("run_tool_calls: call id=%s tool [%s] denied (level=%s)",
                           call_id, name, level)
        elif level == ASK:
            logger.info("run_tool_calls: call id=%s tool [%s] requires approval, arguments=%s",
                        call_id, name, arguments)
            if approver is None:
                result = f"tool call rejected: no approver configured for {name}"
                logger.warning("run_tool_calls: call id=%s tool [%s] needs approval but no approver",
                               call_id, name)
            else:
                decision = approver(tool, arguments)
                if not decision.approved:
                    result = f"tool call rejected by user: {name} ({decision.reason})"
                    logger.info("run_tool_calls: call id=%s tool [%s] rejected: %s",
                                call_id, name, decision.reason)
                else:
                    logger.info("run_tool_calls: call id=%s tool [%s] approved: %s",
                                call_id, name, decision.reason)
                    result = tool.run(arguments)
        else:
            logger.info("run_tool_calls: call id=%s -> tool [%s], arguments=%s",
                        call_id, name, arguments)
            result = tool.run(arguments)

        logger.info("run_tool_calls: call id=%s tool [%s] level=%s result=%s",
                    call_id, name, level, result)
        messages.append({"role": "tool", "tool_call_id": call_id, "content": result})
    logger.info("run_tool_calls: done, %d message(s) produced", len(messages))
    return messages