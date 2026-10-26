import logging

logging.basicConfig(level=logging.INFO,
                    format="%(levelname)s %(name)s: %(message)s")

from nano_agent.tool import Tool, run_tool_calls

t = Tool("add", "add two ints",
         {"type": "object",
          "properties": {"a": {"type": "integer"}, "b": {"type": "integer"}},
          "required": ["a", "b"]},
         lambda a, b: a + b)

print("success ->", run_tool_calls({"add": t}, [{"id": "c1", "function": {"name": "add", "arguments": '{"a":1,"b":2}'}}]))
print("unknown ->", run_tool_calls({}, [{"id": "c2", "function": {"name": "nope", "arguments": "{}"}}]))
print("error   ->", run_tool_calls({"add": t}, [{"id": "c3", "function": {"name": "add", "arguments": '{"a":1}'}}]))