"""Sanity-check script for the ``log_limit`` parameter of ``plan_and_execute``.

Runs the same task with several ``log_limit`` values so you can see how the
log output changes. Only the log display is affected; agent data stays intact.

Run from the repository root:

    python -m nano_agent.test_log_limit
"""

import logging

from nano_agent import Agent, EchoLLM
from nano_agent.agent import DEFAULT_LOG_LIMIT, _clip, plan_and_execute

TASK = "T" * 300          # long task, forces truncation at small limits
REPLY = "R" * 250         # long executor reply
PLAN = '{"steps": ["step one", "step two"]}'


def check_clip() -> None:
    """Unit-level assertions for the truncation helper itself."""
    assert _clip("abc") == "abc"                       # short text untouched
    assert _clip("x" * 300, 50) == "x" * 50 + "...(truncated, 300 chars total)"
    assert _clip("x" * 300, 0) == "x" * 300            # 0 disables clipping
    assert _clip("x" * 300, -1) == "x" * 300           # negative disables too
    assert _clip("x" * 300) == "x" * DEFAULT_LOG_LIMIT + "...(truncated, 300 chars total)"
    print(f"_clip assertions passed (default limit = {DEFAULT_LOG_LIMIT})\n")


def run_case(log_limit: int | None) -> None:
    label = "default (None)" if log_limit is None else str(log_limit)
    print("=" * 70)
    print(f"log_limit = {label}")
    print("=" * 70)
    executor = Agent(client=EchoLLM(), tools=[])
    executor.chat = lambda prompt, **kwargs: REPLY
    planner = Agent(client=EchoLLM(), tools=[])
    planner.chat = lambda *args, **kwargs: PLAN
    steps, result = plan_and_execute(TASK, executor, planner=planner, log_limit=log_limit)
    # returned data must never be truncated, regardless of log_limit
    assert result == REPLY
    assert steps == ["step one", "step two"]
    print(f"--> returned {len(steps)} steps, result length = {len(result)} (untruncated)\n")


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    check_clip()
    for value in (None, 40, 500, 0, -1):
        run_case(value)
    print("all log_limit cases passed.")
