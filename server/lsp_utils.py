# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License.
"""Utility functions and classes for use with running tools over LSP.

Thin wrapper: delegates to vscode-common-python-lsp shared package,
providing backward-compatible names used by lsp_server.py.
"""

from __future__ import annotations

from typing import Sequence
import pathlib
import sys

from vscode_common_python_lsp import (
    RunResult,
    classify_python_file,
)
from vscode_common_python_lsp import run_module as _run_module
from vscode_common_python_lsp import run_path as _run_path

__all__ = [
    "is_stdlib_file",
    "run_module",
    "run_path",
]


# Compatibility wrapper: the shared package uses classify_python_file()
# returning a PythonFileKind enum; this preserves the old boolean API.
def is_same_path(file_path1: str, file_path2: str) -> bool:
    """Returns true if two paths are the same."""
    return pathlib.Path(file_path1) == pathlib.Path(file_path2)

def win_path_to_posix(path: str) -> str:
    """
    自动识别并转换 Windows 带盘符路径为 POSIX 格式（如 D:/tmp → /d/tmp），
    非 Windows 路径原样返回。
    """
    # print(type(path))
    if not isinstance(path, str):
        return path
    if not sys.platform.startswith('cygwin'):
        # print("not cygwin")
        return path

    # 快速判断：是否以 "X:\" 或 "X:/" 开头（X 为字母）
    # 快速初步检查：长度至少3，且第2个字符是 ':'，第3个是 '/' 或 '\\'
    # 例如: "C:/", "d:\\"
    if len(path) < 3 or path[1] != ':' or path[2] not in ('/', '\\'):
        return path
    # 检查第一个字符是否为字母（A-Z, a-z）
    if not path[0].isalpha():
        return path
    # if not re.match(r'^[a-zA-Z]:[/\\]', path):
        # return path

    try:
        p = pathlib.PureWindowsPath(path)
        if not p.drive or not p.is_absolute():
            return path

        drive_letter = p.drive.rstrip(':').lower()
        rel_parts = p.parts[1:]  # 跳过第一个元素（如 'D:\\'）

        # 构造 POSIX 路径
        posix_path = pathlib.PurePosixPath('/') / drive_letter / pathlib.PurePosixPath(*rel_parts)
        return str(posix_path)

    except Exception:
        # 出错时保守返回原路径
        return path

def normalize_path(file_path: str) -> str:
    """Returns normalized path."""
    return str(pathlib.Path(win_path_to_posix(str(file_path))).resolve())


def is_current_interpreter(executable) -> bool:
    """Returns true if the executable path is same as the current interpreter."""
    return is_same_path(executable, sys.executable)


def is_stdlib_file(file_path: str) -> bool:
    """Return True if the file belongs to a non-user Python path.

    The original implementation included stdlib, system site-packages,
    user site-packages, and extensions dir. Matching that broad semantics.
    """
    return classify_python_file(file_path) is not None


# Compatibility wrappers: the shared package's run_module does not accept
# a timeout parameter (in-process execution cannot be reliably timed out).
# The original lsp_utils accepted it as a no-op.  run_path passes through.


def run_module(
    module: str,
    argv: Sequence[str],
    use_stdin: bool,
    cwd: str,
    source: str = None,
    timeout: float = None,
) -> RunResult:
    """Runs as a module. timeout is accepted for compatibility but ignored."""
    return _run_module(module, argv, use_stdin, cwd, source)


def run_path(
    argv: Sequence[str],
    use_stdin: bool,
    cwd: str,
    source: str = None,
    timeout: float = None,
) -> RunResult:
    """Runs as an executable."""
    return _run_path(argv, use_stdin, cwd, source, timeout=timeout)
