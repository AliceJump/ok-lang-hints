# -*- coding: utf-8 -*-
"""用 AST 安全解析 ok-script 项目的 src/config.py，提取任务注册表，不导入任何模块。

用法: python parse_config_tasks.py <project_dir>
输出(最后一行 JSON): {"ok": true, "config_module": "src.config", "onetime": [...], "trigger": [...]}
"""
import ast
import json
import os
import sys

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")


def extract_tasks(src_path):
    with open(src_path, encoding="utf-8") as f:
        tree = ast.parse(f.read())
    onetime = []
    trigger = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Dict):
            continue
        for k, v in zip(node.keys, node.values):
            if not (k and isinstance(k, ast.Constant)):
                continue
            key = k.value
            if key not in ("onetime_tasks", "trigger_tasks"):
                continue
            if not isinstance(v, ast.List):
                continue
            for el in v.elts:
                if isinstance(el, ast.List) and len(el.elts) >= 2:
                    mod = el.elts[0].value if isinstance(el.elts[0], ast.Constant) else None
                    cls = el.elts[1].value if isinstance(el.elts[1], ast.Constant) else None
                    if mod and cls:
                        (onetime if key == "onetime_tasks" else trigger).append(
                            {"module": mod, "class": cls})
    return onetime, trigger


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "缺少 project_dir 参数"}, ensure_ascii=False))
        sys.exit(1)
    project_dir = sys.argv[1]
    for candidate in (
        os.path.join(project_dir, "src", "config.py"),
        os.path.join(project_dir, "config.py"),
    ):
        if os.path.exists(candidate):
            onetime, trigger = extract_tasks(candidate)
            is_src = candidate.endswith(os.path.join("src", "config.py"))
            config_module = "src.config" if is_src else "config"
            print(json.dumps({
                "ok": True,
                "project": os.path.basename(project_dir),
                "config_module": config_module,
                "onetime": onetime,
                "trigger": trigger,
            }, ensure_ascii=False))
            sys.exit(0)
    print(json.dumps({"ok": False, "error": f"找不到 config.py: {project_dir}"}, ensure_ascii=False))
    sys.exit(1)


if __name__ == "__main__":
    main()
