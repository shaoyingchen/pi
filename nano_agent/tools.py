"""内置工具集：可直接交给 ``nano_agent.Agent`` 使用的常用工具。

用法::

    from nano_agent import Agent
    from nano_agent.tools import make_read_file_tool

    agent = Agent(tools=[make_read_file_tool(root="d:/study/pi")])
    print(agent.chat("读一下 nano_agent/tool.py 的第 1 到 20 行"))

所有工具都遵循 ``nano_agent.tool.Tool`` 的约定：参数用 JSON schema 描述，
返回值必须是字符串（失败也返回字符串，让模型有机会自行纠错）。
"""

from __future__ import annotations

import logging
import os

try:
    from .tool import Tool          # 包内引用（from nano_agent import ...）
except ImportError:
    from tool import Tool           # 脚本方式引用（python agent.py）

logger = logging.getLogger(__name__)

# 单次读取的默认上限，避免一个工具调用把整份大文件塞进上下文
DEFAULT_MAX_BYTES = 64 * 1024
DEFAULT_MAX_LINES = 400


def _resolve_safe_path(path: str, root: str) -> str | None:
    """把 ``path`` 解析成绝对路径，并校验它位于 ``root`` 之内。

    ``root`` 之外的路径（含 ``..`` 穿越、软链指向外部）返回 ``None``，
    由调用方转成工具错误信息，防止模型读取沙箱外的文件。
    """
    target = os.path.realpath(os.path.join(root, path))
    if target != root and not target.startswith(root + os.sep):
        return None
    return target


def make_read_file_tool(root: str | None = None,
                        max_bytes: int = DEFAULT_MAX_BYTES,
                        max_lines: int = DEFAULT_MAX_LINES) -> Tool:
    """构造只读工具 ``read_file``，用于让模型按行读取文本文件。

    ``root``: 允许访问的根目录，默认当前工作目录；越界路径一律拒绝。
    ``max_bytes``: 单次读取的字节上限，超出部分截断并在结果中标注。
    ``max_lines``: 单次返回的行数上限，超出部分截断并在结果中标注。
    """
    base = os.path.realpath(root or os.getcwd())
    if not os.path.isdir(base):
        raise ValueError(f"read_file root is not a directory: {base}")
    logger.info("read_file tool init, root=%s, max_bytes=%d, max_lines=%d",
                base, max_bytes, max_lines)

    def read_file(path: str, start_line: int = 1, end_line: int = 0) -> str:
        """读取文本文件内容；``start_line``/``end_line`` 为 1 起始的闭区间行号。"""
        if not str(path or "").strip():
            return "read_file error: path is required"
        raw_path = str(path).strip()
        target = _resolve_safe_path(raw_path, base)
        if target is None:
            logger.warning("read_file: path escapes root, path=%r, root=%s", raw_path, base)
            return f"read_file error: path outside allowed root {base}: {raw_path}"
        if not os.path.isfile(target):
            return f"read_file error: not a readable file: {raw_path}"

        with open(target, "rb") as fp:
            raw = fp.read(max_bytes + 1)
        byte_truncated = len(raw) > max_bytes
        raw = raw[:max_bytes]
        if b"\x00" in raw:
            logger.warning("read_file: binary file rejected, path=%r", target)
            return f"read_file error: binary file not supported: {raw_path}"
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            logger.warning("read_file: non utf-8 file rejected, path=%r", target)
            return f"read_file error: not a utf-8 text file: {raw_path}"

        lines = text.splitlines()
        total = len(lines)
        if total == 0:
            return f"[read_file] {raw_path}: empty file"

        # 行号统一收敛到合法区间：非法入参按默认值处理，避免抛异常中断对话
        first = max(1, int(start_line or 1))
        requested_last = int(end_line or 0)
        last = min(requested_last if requested_last > 0 else total, total)
        if first > last:
            return (f"read_file error: invalid line range {first}-{last} "
                    f"for {raw_path} ({total} line(s))")
        notes: list[str] = []
        if last - first + 1 > max_lines:
            last = first + max_lines - 1
            notes.append(f"capped at {max_lines} lines")
        if byte_truncated:
            notes.append(f"truncated at {max_bytes} bytes")

        body = "\n".join(lines[first - 1:last])
        result = f"{body}\n\n[read_file] {raw_path}: lines {first}-{last} of {total}"
        if notes:
            result += " (" + "; ".join(notes) + ")"
        return result

    return Tool(
        name="read_file",
        description=("Read a UTF-8 text file inside the workspace and return its content. "
                     "Use start_line/end_line (1-based, inclusive) to page through large files."),
        parameters={"type": "object",
                    "properties": {
                        "path": {"type": "string",
                                 "description": "File path, absolute or relative to the workspace root."},
                        "start_line": {"type": "integer",
                                       "description": "First line to return (1-based), default 1."},
                        "end_line": {"type": "integer",
                                     "description": "Last line to return (1-based, inclusive), "
                                                    "0 or omitted means end of file."},
                    },
                    "required": ["path"]},
        fn=read_file,
    )
