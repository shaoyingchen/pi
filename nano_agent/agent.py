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
"""

from __future__ import annotations

import os

import openai

try:
    from .tool import Tool, run_tool_calls   # package context (from nano_agent import ...)
except ImportError:
    from tool import Tool, run_tool_calls    # plain-script context (python agent.py)


# ---------------------------------------------------------------------------
# LLM client: chat completions via the OpenAI SDK
# ---------------------------------------------------------------------------

class LLMClient:
    """Thin wrapper around the OpenAI SDK chat completions endpoint."""

    def __init__(self, base_url: str | None = None, api_key: str | None = None, model: str | None = None):
        self.base_url = base_url or os.getenv("OPENAI_BASE_URL") or "https://api.openai.com/v1"
        self.api_key = api_key or os.getenv("OPENAI_API_KEY", "")
        self.model = model or os.getenv("OPENAI_MODEL", "gpt-4o-mini")
        self.client = openai.OpenAI(api_key=self.api_key, base_url=self.base_url)

    def chat(self, messages: list[dict], tools: list[dict] | None = None,
             temperature: float = 0.7) -> dict:
        """Return the raw response message dict, including tool_calls when present."""
        kwargs: dict = {"model": self.model, "messages": messages, "temperature": temperature}
        if tools:
            kwargs["tools"] = tools
        completion = self.client.chat.completions.create(**kwargs)
        return completion.choices[0].message.model_dump(exclude_none=True)


# ---------------------------------------------------------------------------
# Minimal agent loop
# ---------------------------------------------------------------------------

class Agent:
    """Repeatedly ask the LLM for a turn; if it requests tools, run them and retry."""

    def __init__(self, system: str = "You are a helpful assistant.",
                 tools: list[Tool] | None = None, client: LLMClient | None = None):
        self.system = system
        self.tools = {t.name: t for t in (tools or [])}
        self.client = client or LLMClient()

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
            messages.extend(run_tool_calls(self.tools, calls))

        return messages[-1].get("content") or "(max rounds reached)"


# ---------------------------------------------------------------------------
# Run a REPL-style session when executed directly
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import logging
    import sys

    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")

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