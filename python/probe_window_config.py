# -*- coding: utf-8 -*-
"""用 AST 安全解析 ok-script 项目的 config.py，提取窗口匹配信息（exe_names, title 等）。

查找策略：先通过 main.py 内的 import 信息定位 config.py 的实际路径，
再回退到常见的 src/config.py 或 config.py。

用法: python probe_window_config.py <project_dir>
输出(最后一行 JSON):
  {"ok": true, "exe_names": [...], "title": "...", "player_id": N, "hwnd_class": "..."}
"""
import ast
import json
import os
import re
import sys

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

# 需要从 config dict 中提取的窗口匹配相关字段
# config["windows"] 下的键
WINDOWS_SUB_KEYS = ("exe", "title", "hwnd_class", "top_hwnd_class", "capture_method")


def _resolve_config_path_from_main(project_dir):
    """解析 main.py，找到 config 模块的导入路径，转为文件系统路径。"""
    for main_name in ("main.py", "run.py", "run_task.py"):
        main_path = os.path.join(project_dir, main_name)
        if not os.path.isfile(main_path):
            continue
        try:
            with open(main_path, encoding="utf-8") as f:
                tree = ast.parse(f.read(), filename=main_path)
        except (OSError, SyntaxError):
            continue
        for node in ast.walk(tree):
            # from src.config import config  /  from config import config
            if isinstance(node, ast.ImportFrom) and node.module:
                mod = node.module
                # 检查是否有 import ... config
                has_config = any(
                    (alias.name == "config" if isinstance(alias, ast.alias) else alias == "config")
                    for alias in (node.names or [])
                )
                if not has_config:
                    continue
                # 把模块路径转为文件路径
                parts = mod.split(".")
                candidate = os.path.join(project_dir, *parts, "config.py")
                if os.path.isfile(candidate):
                    return candidate
                # 模块本身可能就是 config（from config import config）
                candidate2 = os.path.join(project_dir, *parts) + ".py"
                if os.path.isfile(candidate2):
                    return candidate2
            # import src.config  /  import config
            if isinstance(node, ast.Import):
                for alias in (node.names or []):
                    name = alias.name if isinstance(alias, ast.alias) else alias
                    if not name.endswith(".config") and name != "config":
                        continue
                    parts = name.split(".")
                    candidate = os.path.join(project_dir, *parts, "config.py")
                    if os.path.isfile(candidate):
                        return candidate
                    candidate2 = os.path.join(project_dir, *parts) + ".py"
                    if os.path.isfile(candidate2):
                        return candidate2
    return None


def _resolve_config_path(project_dir):
    """综合查找 config.py：先 main.py 解析，再常规路径。"""
    # 1. 通过 main.py 定位
    found = _resolve_config_path_from_main(project_dir)
    if found:
        return found
    # 2. 常规路径
    for candidate in (
        os.path.join(project_dir, "src", "config.py"),
        os.path.join(project_dir, "config.py"),
    ):
        if os.path.isfile(candidate):
            return candidate
    return None


def _extract_config_dict_keys(config_path):
    """用 AST 解析 config.py，找到顶层 config dict，提取 windows 子字典的窗口匹配字段。"""
    with open(config_path, encoding="utf-8") as f:
        tree = ast.parse(f.read(), filename=config_path)

    config_dict = None
    # 寻找 config = {...}
    for node in ast.iter_child_nodes(tree):
        if not isinstance(node, ast.Assign):
            continue
        for target in node.targets:
            if isinstance(target, ast.Name) and target.id == "config":
                if isinstance(node.value, ast.Dict):
                    config_dict = node.value
                break
        if config_dict:
            break
    # 回退
    if not config_dict:
        for node in ast.walk(tree):
            if not isinstance(node, ast.Assign):
                continue
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id == "config" and isinstance(node.value, ast.Dict):
                    config_dict = node.value
                    break
            if config_dict:
                break

    if not config_dict:
        return {}

    # 从 config dict 中提取 "windows" 子字典
    for key, value in zip(config_dict.keys, config_dict.values):
        if isinstance(key, ast.Constant) and key.value == "windows" and isinstance(value, ast.Dict):
            result = {}
            for wk, wv in zip(value.keys, value.values):
                if isinstance(wk, ast.Constant) and wk.value in WINDOWS_SUB_KEYS:
                    result[wk.value] = _extract_value(wv)
            return result
    return {}


def _extract_value(node):
    """递归提取 AST 节点的 Python 值。"""
    if isinstance(node, ast.Constant):
        return node.value
    if isinstance(node, ast.List):
        return [_extract_value(el) for el in node.elts]
    if isinstance(node, ast.Tuple):
        return [_extract_value(el) for el in node.elts]
    if isinstance(node, ast.Name):
        # 引用其他变量，返回变量名标记
        return f"<ref:{node.id}>"
    if isinstance(node, ast.Call):
        # 常见模式: re.compile(r"xxx") → 提取字符串参数
        func = node.func
        if isinstance(func, ast.Attribute) and func.attr == "compile":
            if node.args and isinstance(node.args[0], ast.Constant):
                return node.args[0].value
        if isinstance(func, ast.Name) and func.id in ("str", "int", "float"):
            if node.args and isinstance(node.args[0], ast.Constant):
                return node.args[0].value
        # 返回函数名标记
        if isinstance(func, ast.Name):
            return f"<call:{func.id}>"
        if isinstance(func, ast.Attribute):
            return f"<call:{func.attr}>"
    if isinstance(node, ast.Dict):
        return {_extract_value(k): _extract_value(v) for k, v in zip(node.keys, node.values)}
    return None


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "缺少 project_dir 参数"}, ensure_ascii=False))
        sys.exit(1)
    project_dir = sys.argv[1]

    config_path = _resolve_config_path(project_dir)
    if not config_path:
        print(json.dumps({
            "ok": False,
            "error": f"找不到 config.py: {project_dir}",
            "searched": [
                os.path.join(project_dir, "main.py"),
                os.path.join(project_dir, "src", "config.py"),
                os.path.join(project_dir, "config.py"),
            ],
        }, ensure_ascii=False))
        sys.exit(1)

    window_config = _extract_config_dict_keys(config_path)

    # 把 <ref:...> 和 <call:...> 标记替换为 None（无法静态解析的值）
    for k, v in window_config.items():
        if isinstance(v, str) and (v.startswith("<ref:") or v.startswith("<call:")):
            window_config[k] = None
        if isinstance(v, list):
            window_config[k] = [
                item if item is not None and not (isinstance(item, str) and (item.startswith("<ref:") or item.startswith("<call:")))
                else None
                for item in v
            ]

    print(json.dumps({
        "ok": True,
        "config_path": config_path,
        **window_config,
    }, ensure_ascii=False))
    sys.exit(0)


if __name__ == "__main__":
    main()
