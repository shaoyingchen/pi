"""A minimal agent: an LLM chat loop with basic tool calling.

Only uses the Python standard library, so it runs anywhere with Python 3.8+.
Configure via environment variables:

    OPENAI_API_KEY    - required
    OPENAI_BASE_URL   - default https://api.openai.com/v1
    OPENAI_MODEL      - default gpt-4o-mini

Usage:

    python agent.py                      # read terminal input, one round per line
    python -c "from agent import Agent; print(Agent().chat('hi'))"
"""

from __future__ import annotations

import json
import os
import urllib.request
from typing import Callable


# ---------------------------------------------------------------------------
# LLM client: OpenAI-compatible chat completions over HTTP, stdlib only
# ---------------------------------------------------------------------------

class LLMClient:
    """Thin wrapper around an OpenAI-compatible /chat/completions endpoint."""

    def __init__(self, base_url: str | None = None, api_key: str | None = None, model: str | None = None):
        self.base_url = (base_url or os.getenv("OPENAI_BASE_URL")
                         or "https://api.openai.com/v1").rstrip("/")
        self.api_key = api_key or os.getenv("OPENAI_API_KEY", "")
        self.model = model or os.getenv("OPENAI_MODEL", "gpt-4o-mini")

    def chat(self, messages: list[dict], tools: list[dict] | None = None,
             temperature: float = 0.7) -> dict:
        """Return the raw response message dict, including tool_calls when present."""
        payload = {"model": self.model, "messages": messages, "temperature": temperature}
        if tools:
            payload["tools"] = tools
        request = urllib.request.Request(
            f"{self.base_url}/chat/completions",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json",
                     "Authorization": f"Bearer {self.api_key}"},
            method="POST",
        )
        with urllib.request.urlopen(request) as resp:
            body = json.loads(resp.read().decode("utf-8"))
        return body["choices"][0]["message"]


# ---------------------------------------------------------------------------
# Minimal agent loop
# ---------------------------------------------------------------------------

class Tool:
    """A callable the model can invoke; name/description/payload drive the prompt."""

    def __init__(self, name: str, description: str, parameters: dict, fn: Callable[..., str]):
        self.name = name
        self.description = description
        self.parameters = parameters
        self.fn = fn

    def run(self, arguments: dict) -> str:
        try:
            return str(self.fn(**arguments))
        except Exception as exc:                # report tool errors back to the model
            return f"tool error: {exc}"

    def schema(self) -> dict:
        return {"type": "function",
                "function": {"name": self.name, "description": self.description,
                             "parameters": self.parameters}}


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
            for call in calls:
                self._execute_call(messages, call)

        return messages[-1].get("content") or "(max rounds reached)"

    def _execute_call(self, messages: list[dict], call: dict) -> None:
        fn = call["function"]
        tool = self.tools.get(fn["name"])
        result = tool.run(json.loads(fn.get("arguments") or "{}")) if tool \
            else f"unknown tool: {fn['name']}"
        messages.append({"role": "tool", "tool_call_id": call["id"], "content": result})


# ---------------------------------------------------------------------------
# Run a REPL-style session when executed directly
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import sys

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