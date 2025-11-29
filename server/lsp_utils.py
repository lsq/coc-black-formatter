# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License.
"""Utility functions and classes for use with running tools over LSP."""
from __future__ import annotations

import contextlib
import io
import os
import pathlib
import runpy
import site
import subprocess
import sys
import sysconfig
import threading
# import re
from typing import Any, Callable, List, Sequence, Tuple, Union

# Save the working directory used when loading this module
SERVER_CWD = os.getcwd()
CWD_LOCK = threading.Lock()


def as_list(content: Union[Any, List[Any], Tuple[Any]]) -> List[Any]:
    """Ensures we always get a list"""
    if isinstance(content, (list, tuple)):
        return list(content)
    return [content]


def _get_sys_config_paths() -> List[str]:
    """Returns paths from sysconfig.get_paths()."""
    return [
        path
        for group, path in sysconfig.get_paths().items()
        if group not in ["data", "platdata", "scripts"]
    ]


def _get_extensions_dir() -> List[str]:
    """This is the extensions folder under ~/.vscode or ~/.vscode-server."""

    # The path here is calculated relative to the tool
    # this is because users can launch VS Code with custom
    # extensions folder using the --extensions-dir argument
    path = pathlib.Path(__file__).parent.parent.parent.parent
    #                              ^     bundled  ^  extensions
    #                            tool        <extension>
    if path.name == "extensions":
        return [os.fspath(path)]
    return []


_stdlib_paths = set(
    str(pathlib.Path(p).resolve())
    for p in (
        as_list(site.getsitepackages())
        + as_list(site.getusersitepackages())
        + _get_sys_config_paths()
        + _get_extensions_dir()
    )
)


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
    """Return True if the file belongs to the standard library."""
    normalized_path = str(pathlib.Path(file_path).resolve())
    return any(normalized_path.startswith(path) for path in _stdlib_paths)


# pylint: disable-next=too-few-public-methods
class RunResult:
    """Object to hold result from running tool."""

    def __init__(self, stdout, stderr):
        self.stdout = stdout
        self.stderr = stderr


class CustomIO(io.TextIOWrapper):
    """Custom stream object to replace stdio."""

    name = None

    def __init__(self, name, encoding="utf-8", newline=None):
        self._buffer = io.BytesIO()
        self._buffer.name = name
        super().__init__(self._buffer, encoding=encoding, newline=newline)

    def close(self):
        """Provide this close method which is used by some tools."""
        # This is intentionally empty.

    def get_value(self) -> str:
        """Returns value from the buffer as string."""
        self.seek(0)
        return self.read()


@contextlib.contextmanager
def substitute_attr(obj: Any, attribute: str, new_value: Any):
    """Manage object attributes context when using runpy.run_module()."""
    old_value = getattr(obj, attribute)
    setattr(obj, attribute, new_value)
    yield
    setattr(obj, attribute, old_value)


@contextlib.contextmanager
def redirect_io(stream: str, new_stream):
    """Redirect stdio streams to a custom stream."""
    old_stream = getattr(sys, stream)
    setattr(sys, stream, new_stream)
    yield
    setattr(sys, stream, old_stream)


@contextlib.contextmanager
def change_cwd(new_cwd):
    """Change working directory before running code."""
    os.chdir(new_cwd)
    yield
    os.chdir(SERVER_CWD)


def _run_module(
    module: str, argv: Sequence[str], use_stdin: bool, source: str = None
) -> RunResult:
    """Runs as a module."""
    str_output = CustomIO("<stdout>", encoding="utf-8")
    str_error = CustomIO("<stderr>", encoding="utf-8")

    try:
        with substitute_attr(sys, "argv", argv):
            with redirect_io("stdout", str_output):
                with redirect_io("stderr", str_error):
                    if use_stdin and source is not None:
                        str_input = CustomIO("<stdin>", encoding="utf-8", newline="\n")
                        with redirect_io("stdin", str_input):
                            str_input.write(source)
                            str_input.seek(0)
                            runpy.run_module(module, run_name="__main__")
                    else:
                        runpy.run_module(module, run_name="__main__")
    except SystemExit:
        pass

    return RunResult(str_output.get_value(), str_error.get_value())


def run_module(
    module: str, argv: Sequence[str], use_stdin: bool, cwd: str, source: str = None
) -> RunResult:
    """Runs as a module."""
    with CWD_LOCK:
        if is_same_path(os.getcwd(), cwd):
            return _run_module(module, argv, use_stdin, source)
        with change_cwd(cwd):
            return _run_module(module, argv, use_stdin, source)


def run_path(
    argv: Sequence[str], use_stdin: bool, cwd: str, source: str = None
) -> RunResult:
    """Runs as an executable."""
    if use_stdin:
        with subprocess.Popen(
            argv,
            encoding="utf-8",
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            stdin=subprocess.PIPE,
            cwd=cwd,
        ) as process:
            return RunResult(*process.communicate(input=source))
    else:
        result = subprocess.run(
            argv,
            encoding="utf-8",
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            cwd=cwd,
        )
        return RunResult(result.stdout, result.stderr)


def run_api(
    callback: Callable[[Sequence[str], CustomIO, CustomIO, CustomIO | None], None],
    argv: Sequence[str],
    use_stdin: bool,
    cwd: str,
    source: str = None,
) -> RunResult:
    """Run a API."""
    with CWD_LOCK:
        if is_same_path(os.getcwd(), cwd):
            return _run_api(callback, argv, use_stdin, source)
        with change_cwd(cwd):
            return _run_api(callback, argv, use_stdin, source)


def _run_api(
    callback: Callable[[Sequence[str], CustomIO, CustomIO, CustomIO | None], None],
    argv: Sequence[str],
    use_stdin: bool,
    source: str = None,
) -> RunResult:
    str_output = CustomIO("<stdout>", encoding="utf-8")
    str_error = CustomIO("<stderr>", encoding="utf-8")

    try:
        with substitute_attr(sys, "argv", argv):
            with redirect_io("stdout", str_output):
                with redirect_io("stderr", str_error):
                    if use_stdin and source is not None:
                        str_input = CustomIO("<stdin>", encoding="utf-8", newline="\n")
                        with redirect_io("stdin", str_input):
                            str_input.write(source)
                            str_input.seek(0)
                            callback(argv, str_output, str_error, str_input)
                    else:
                        callback(argv, str_output, str_error)
    except SystemExit:
        pass

    return RunResult(str_output.get_value(), str_error.get_value())
