"""Pluggable LLM backends for nano_agent.

A *backend* (provider) is any object exposing `chat(messages, tools=None, **kwargs)`
that returns an OpenAI-style assistant message dict, e.g.::

    {"role": "assistant", "content": "...", "tool_calls": [...]}

Built-in backends
-----------------
- ``openai`` (default): OpenAI-compatible chat completions via the official SDK.
- ``echo``:           a local, dependency-free backend for tests and for
                      dry-running the agent loop without an API key.

Configuring a backend
---------------------
- Programmatically: ``build_llm(provider="...")`` or register your own with
  ``register_llm(name, factory)``.
- Via environment variables (used by ``Agent`` when ``client`` is omitted):

  - ``LLM_PROVIDER``        - backend name to use, default ``openai``
  - ``OPENAI_MODEL``        - model for the ``openai`` backend
  - ``OPENAI_BASE_URL``/``OPENAI_API_KEY`` - connection config for ``openai``

Custom extensions
-----------------
1. Inline::

       register_llm("my", lambda model=None: MyLLM(...))
       build_llm("my")

2. As an installed package exposing an ``entry_point`` in the
   ``nano_agent.llms`` group::

       [project.entry-points."nano_agent.llms"]
       my-llm = "mypkg.llm:MyLLM"

   then use ``build_llm("my-llm")`` or set ``LLM_PROVIDER=my-llm``.
"""

from __future__ import annotations

import importlib.metadata
import logging
import os
from typing import Callable, Mapping

logger = logging.getLogger(__name__)

# Provider factories: name -> callable(model: str | None, **kwargs) -> backend.
_FACTORIES: dict[str, Callable[..., object]] = {}


class BaseLLM:
    """Protocol for a chat backend. Subclass or duck-type with ``chat``."""

    name = "base"

    def chat(self, messages: list[dict], tools: list[dict] | None = None, **kwargs: object) -> dict:
        raise NotImplementedError


def register_llm(name: str, factory: Callable[..., object]) -> None:
    """Register a backend factory under ``name``.

    ``factory`` is called as ``factory(model=None, **kwargs)`` and must return
    an object with ``chat(messages, tools=None, **kwargs) -> dict``.
    """
    if not name or not callable(factory):
        raise ValueError("register_llm requires a non-empty name and a callable factory")
    _FACTORIES[name] = factory
    logger.info("registered LLM backend %r", name)


class OpenAILLM(BaseLLM):
    """OpenAI-compatible chat completions backend (default)."""

    name = "openai"

    def __init__(self, base_url: str | None = None, api_key: str | None = None,
                 model: str | None = None):
        import openai  # top-level import kept local so non-OpenAI backends stay optional

        self.base_url = base_url or os.getenv("OPENAI_BASE_URL") or "https://api.openai.com/v1"
        self.api_key = api_key or os.getenv("OPENAI_API_KEY", "")
        self.model = model or os.getenv("OPENAI_MODEL", "gpt-4o-mini")
        self.client = openai.OpenAI(api_key=self.api_key, base_url=self.base_url)

    def chat(self, messages: list[dict], tools: list[dict] | None = None, **kwargs: object) -> dict:
        params: dict = {"model": self.model, "messages": messages, **kwargs}
        if tools:
            params["tools"] = tools
        completion = self.client.chat.completions.create(**params)
        return completion.choices[0].message.model_dump(exclude_none=True)


def _build_openai(model: str | None, **kwargs: object) -> OpenAILLM:
    return OpenAILLM(model=model, **kwargs)


def _build_echo(model: str | None, **_kwargs: object) -> "EchoLLM":
    return EchoLLM(model=model or "echo")


class EchoLLM(BaseLLM):
    """Deterministic local backend: mimics a single assistant turn.

    If the conversation includes a ``role: tool`` message it replies with the
    tool result's content; otherwise it echoes the last user message. Useful
    for tests and for exercising the agent loop without network access.
    """

    name = "echo"

    def __init__(self, model: str = "echo"):
        self.model = model

    def chat(self, messages: list[dict], tools: list[dict] | None = None, **kwargs: object) -> dict:
        role = "assistant"
        if messages and messages[-1].get("role") == "tool":
            content = str(messages[-1].get("content", ""))
            if not content:
                content = "(received an empty tool result)"
        else:
            content = self._last_user_content(messages)
        return {"role": role, "content": content}

    @staticmethod
    def _last_user_content(messages: list[dict]) -> str:
        for message in reversed(messages):
            if message.get("role") == "user":
                return str(message.get("content", ""))
        return "(no user message)"


def _load_entry_points() -> Mapping[str, Callable[..., object]]:
    """Load LLM backends published as ``nano_agent.llms`` entry points."""
    discovered: dict[str, Callable[..., object]] = {}
    try:
        eps = importlib.metadata.entry_points()
        group = eps.select(group="nano_agent.llms") if hasattr(eps, "select") else eps.get("nano_agent.llms", [])
        for ep in group:
            factory = ep.load()
            if not callable(factory):
                logger.warning("entry point %r in nano_agent.llms is not callable; skipped", ep.name)
                continue
            discovered[ep.name] = factory
            logger.info("discovered LLM backend %r from entry point %r", ep.name, ep.value)
    except Exception as exc:  # never let plugin discovery break normal startup
        logger.warning("failed to load LLM entry points: %s", exc)
    return discovered


def build_llm(provider: str | None = None, model: str | None = None, **kwargs: object) -> BaseLLM:
    """Build a backend by name, defaulting to ``LLM_PROVIDER`` then ``openai``.

    Resolution order: registered factories (built-ins + ``register_llm``), then
    ``nano_agent.llms`` entry points. Unknown providers raise ``ValueError``.
    """
    name = provider or os.getenv("LLM_PROVIDER") or "openai"
    registry = {**_FACTORIES, **_load_entry_points()}
    factory = registry.get(name)
    if factory is None:
        raise ValueError(
            f"unknown LLM provider {name!r}; registered: {sorted(registry) or 'none'}"
        )
    logger.info("building LLM backend %r (model=%r, extra kwargs=%s)", name, model, sorted(kwargs))
    try:
        backend = factory(model=model, **kwargs)
    except TypeError:
        logger.warning("factory for %r does not accept kwargs; calling with model only", name)
        backend = factory(model=model)
    if not hasattr(backend, "chat"):
        raise TypeError(f"LLM provider {name!r} factory returned an object without chat()")
    return backend


# Register built-in backends at import time.
register_llm("openai", _build_openai)
register_llm("echo", _build_echo)
