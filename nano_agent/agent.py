"""A minimal agent: an LLM chat loop with basic tool calling.

Uses the official OpenAI SDK and works with any OpenAI-compatible endpoint.
Install the dependency first:

    python -m pip install openai

Configure via environment variables:

    OPENAI_API_KEY    - required
    OPENAI_BASE_URL   - default https://api.openai.com/v1
    OPENAI_MODEL      - default gpt-4o-mini

Usage:

    python agent.py                      # read terminal input, one round per line
    python -c "from agent import Agent; print(Agent().chat('hi'))"

Reuse the tool module from other code:

    from nano_agent.tool import Tool, run_tool_calls

Agent-to-Agent (A2A) composition:

    math = Agent(tools=[calculate_tool])
    parent = Agent(tools=[make_agent_tool(math, "math_agent", "delegate arithmetic")])
    parent.chat("ask the math agent for 2+2")

A child Agent exposed via ``make_agent_tool`` runs its own full tool loop when
invoked, so nesting is recursive: the parent loop consumes the child's final
reply as a regular ``role: tool`` result.
"""

from __future__ import annotations

import os
import sys
from typing import Callable

try:
    from .llm import BaseLLM, build_llm            # package context (from nano_agent import ...)
    from .tool import Tool, ApprovalDecision, run_tool_calls
except ImportError:
    from llm import BaseLLM, build_llm             # plain-script context (python agent.py)
    from tool import Tool, ApprovalDecision, run_tool_calls


# ---------------------------------------------------------------------------
# LLM client: chat completions via the OpenAI SDK (kept for back-compat)
# ---------------------------------------------------------------------------

class LLMClient:
    """Thin wrapper around the OpenAI SDK chat completions endpoint.

    Deprecated convenience alias: prefer ``build_llm("openai", ...)`` or the
    ``OpenAILLM`` backend, which is backend-agnostic via ``nano_agent.llm``.
    """

    def __init__(self, base_url: str | None = None, api_key: str | None = None, model: str | None = None):
        self._llm = build_llm("openai", base_url=base_url, api_key=api_key, model=model)

    def chat(self, messages: list[dict], tools: list[dict] | None = None, **kwargs: object) -> dict:
        """Return the raw response message dict, including tool_calls when present."""
        return self._llm.chat(messages, tools=tools, **kwargs)


# ---------------------------------------------------------------------------
# Minimal agent loop
# ---------------------------------------------------------------------------

class Agent:
    """Repeatedly ask the LLM for a turn; if it requests tools, run them and retry."""

    def __init__(self, system: str = "You are a helpful assistant.",
                 tools: list[Tool] | None = None, client: BaseLLM | None = None,
                 provider: str | None = None, model: str | None = None,
                 approver: Callable[[Tool, dict], ApprovalDecision] | None = None):
        """Build an agent.

        ``client``: any backend exposing ``chat(messages, tools=None, **kwargs)``.
        When omitted, the backend is resolved via ``build_llm(provider, model)``
        (``LLM_PROVIDER`` env var, then ``openai``); pass ``provider="echo"``
        for a dependency-free local backend.

        ``approver``: optional Human-in-the-loop callback
        ``approver(tool, arguments) -> ApprovalDecision`` controlling whether a
        tool call requiring approval may run (see ``Tool.requires_approval``).
        """
        self.system = system
        self.tools = {t.name: t for t in (tools or [])}
        self.approver = approver
        self.client = client or build_llm(provider=provider, model=model)

    def chat(self, user_message: str, max_rounds: int = 10) -> str:
        """Run a full conversation turn and return the final assistant text."""
        messages: list[dict] = [
            {"role": "system", "content": self.system},
            {"role": "user", "content": user_message},
        ]
        tool_schemas = [t.schema() for t in self.tools.values()]

        for _ in range(max_rounds):
            reply = self.client.chat(messages, tools=tool_schemas or None)
            messages.append(reply)

            calls = reply.get("tool_calls") or []
            if not calls:
                return reply.get("content") or ""

            # execute tool calls, append results, and continue the loop
            messages.extend(run_tool_calls(self.tools, calls, approver=self.approver))

        return messages[-1].get("content") or "(max rounds reached)"


# ---------------------------------------------------------------------------
# Agent-to-Agent (A2A) composition
# ---------------------------------------------------------------------------

def make_agent_tool(child: "Agent", name: str | None = None,
                    description: str | None = None) -> Tool:
    """Wrap an ``Agent`` as a ``Tool`` so a parent agent can delegate to it (A2A).

    Invoking the returned tool runs ``child.chat(task)`` end-to-end (the child
    runs its own tool loop) and returns the child's final reply. Because the
    tool parameters are a single free-form ``task`` string, a parent can chain
    arbitrarily: creating, say, ``Agent(tools=[specialist_a, specialist_b])``
    lets the parent orchestrate specialist sub-agents.
    """
    return Tool(
        name=name or f"agent_{child.client.name if hasattr(child.client, 'name') else 'sub'}",
        description=description or "Delegate the task to a sub-agent and return its final answer.",
        parameters={"type": "object",
                    "properties": {"task": {"type": "string",
                                            "description": "Task/instruction to send to the sub-agent."}},
                    "required": ["task"]},
        fn=lambda task: child.chat(task),   # noqa: S307 - intentionally invokes the child loop
    )


def _run_a2a_example() -> None:
    """Demo of A2A composition that needs no API key (uses the ``echo`` backend).

    Renders a 3-level tree: root -> research sub-agent -> math sub-agent.
    The root asks the research agent, which delegates the numeric part to the
    math agent. Because ``EchoLLM`` answers with the last user/tool message,
    this deterministically exercises the parent->child->grandchild plumbing.
    """
    try:
        from .llm import EchoLLM    # package context
    except ImportError:
        from llm import EchoLLM     # plain-script context (python agent.py)

    echo = EchoLLM()

    math = Agent(system="Math specialist.", client=echo,
                 tools=[Tool("calc", "add two numbers",
                             {"type": "object",
                              "properties": {"a": {"type": "integer"}, "b": {"type": "integer"}},
                              "required": ["a", "b"]},
                             lambda a, b: a + b)])

    research = Agent(system="Research specialist.", client=echo,
                     tools=[make_agent_tool(math, "math_agent", "Delegates math tasks.")])

    root = Agent(system="You are the root orchestrator.", client=echo,
                 tools=[make_agent_tool(research, "research_agent", "Delegates research tasks.")])

    print("root -> research_agent(task='figure out 20+22') -> math_agent")
    print(root.chat("figure out 20+22"))
    print("a2a example done.")


# ---------------------------------------------------------------------------
# Run a REPL-style session when executed directly
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import logging

    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    if "--example" in sys.argv and sys.argv[sys.argv.index("--example") + 1:][:1] == ["a2a"]:
        _run_a2a_example()
        sys.exit(0)

    # example tool bundled by default so the minimal agent does something useful
    calculator = Tool(
        name="calculate",
        description="Evaluate a basic arithmetic expression, e.g. '2 * (3 + 4)'.",
        parameters={"type": "object",
                    "properties": {"expression": {"type": "string"}},
                    "required": ["expression"]},
        fn=lambda expression: repr(eval(expression)),      # noqa: S307 - demo only
    )

    if not os.getenv("OPENAI_API_KEY"):
        sys.exit("OPENAI_API_KEY is not set; export it and try again.")

    agent = Agent(system="You are a helpful assistant with arithmetic skills.",
                  tools=[calculator])

    print('nano agent ready. type "exit" or Ctrl+C to quit.')
    while True:
        user_input = input("> ").strip()
        if user_input in ("exit", "quit"):
            break
        print(agent.chat(user_input))