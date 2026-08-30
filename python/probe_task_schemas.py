# -*- coding: utf-8 -*-
"""全量 import 采集 ok-script 项目所有任务的配置 schema。

复用 ok-script 的 OK(config) + TaskManager 初始化来实例化任务，拿到经过继承链
合并的真实 default_config / config_type / config_description / 已保存 config。
逐任务 try/except 容错，坏任务标记 broken，不影响其他任务。

用法: python probe_task_schemas.py <project_dir>
输出(最后一行 JSON): {"ok": true, "total": N, "broken": [...], "schemas": {...}}
"""
import ast
import json
import os
import shutil
import sys
import tempfile
from enum import Enum

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")


UNSERIALIZABLE = object()


def jsonable(v):
    """转成可 JSON 序列化形式；不可序列化对象返回 UNSERIALIZABLE。"""
    if v is None or isinstance(v, (bool, int, float, str)):
        return v
    if isinstance(v, Enum):
        return jsonable(v.value)
    if isinstance(v, (list, tuple)):
        out = []
        for x in v:
            jx = jsonable(x)
            if jx is not UNSERIALIZABLE:
                out.append(jx)
        return out
    if isinstance(v, dict):
        out = {}
        for k, x in v.items():
            jx = jsonable(x)
            if jx is not UNSERIALIZABLE:
                out[str(k)] = jx
        return out
    return UNSERIALIZABLE


def normalize_group_map(value):
    """规范化配置分组为 {组名: [字段/子组]}，保留声明顺序。"""
    if not isinstance(value, dict):
        return {}
    groups = {}
    for group_name, children in value.items():
        if isinstance(children, str):
            normalized = [children]
        elif isinstance(children, (list, tuple)):
            normalized = [str(item) for item in children if isinstance(item, str)]
        else:
            continue
        groups[str(group_name)] = normalized
    return groups


def find_group_selector(config_type, declared_groups):
    """识别 register_config_groups 生成的分组下拉，而非普通条件下拉。"""
    for key, type_meta in config_type.items():
        if not isinstance(type_meta, dict) or type_meta.get("type") != "drop_down":
            continue
        options = type_meta.get("options")
        rules = type_meta.get("sub_configs")
        if not isinstance(options, (list, tuple)) or not isinstance(rules, dict):
            continue
        normalized_rules = normalize_group_map(rules)
        rule_keys = set(normalized_rules)
        declared_matches = all(
            normalized_rules.get(group_name) == children
            for group_name, children in declared_groups.items()
        )
        if (
            options
            and declared_groups
            and declared_matches
            and all(str(option) in rule_keys for option in options)
        ):
            return str(key), normalized_rules
    return None, {}


def detect_config_folder(project_dir):
    """在导入项目之前用 AST 读取 config_folder，默认 configs。"""
    for candidate in (
        os.path.join(project_dir, "src", "config.py"),
        os.path.join(project_dir, "config.py"),
    ):
        try:
            with open(candidate, encoding="utf-8") as f:
                tree = ast.parse(f.read(), filename=candidate)
        except (OSError, SyntaxError):
            continue
        for node in ast.walk(tree):
            if not isinstance(node, ast.Dict):
                continue
            for key, value in zip(node.keys, node.values):
                if (
                    isinstance(key, ast.Constant)
                    and key.value == "config_folder"
                    and isinstance(value, ast.Constant)
                    and isinstance(value.value, str)
                ):
                    return value.value
    return "configs"


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "缺少 project_dir 参数"}, ensure_ascii=False))
        sys.exit(1)
    project_dir = sys.argv[1]
    sys.path.insert(0, project_dir)
    os.chdir(project_dir)

    temp_dir = tempfile.TemporaryDirectory(prefix="ok-lang-hints-probe-")
    source_config_folder = detect_config_folder(project_dir)
    temp_config_folder = os.path.join(temp_dir.name, "configs")
    source_config_path = os.path.join(project_dir, source_config_folder)
    if os.path.isdir(source_config_path):
        shutil.copytree(source_config_path, temp_config_folder, dirs_exist_ok=True)

    # 项目 config 的导入链也可能用 get_relative_path("configs", ...) 直接
    # 创建/迁移配置；必须在导入前把这类路径统一重定向到沙箱。
    import ok.util.file as ok_file
    from ok.util.config import Config

    original_get_relative_path = ok_file.get_relative_path

    def sandboxed_get_relative_path(*files):
        if files and os.path.normcase(str(files[0])) == "configs":
            return os.path.normpath(os.path.join(temp_config_folder, *files[1:]))
        return original_get_relative_path(*files)

    ok_file.get_relative_path = sandboxed_get_relative_path
    # ok.util.config 在模块导入时复制了函数引用，也需要同步替换。
    import ok.util.config as ok_config
    ok_config.get_relative_path = sandboxed_get_relative_path
    Config.config_folder = temp_config_folder

    try:
        from src.config import config
    except Exception:
        from config import config

    from ok import OK

    cfg = dict(config)
    cfg["use_gui"] = False
    cfg["check_mutex"] = False
    cfg["custom_tasks"] = False
    cfg["config_folder"] = temp_config_folder
    cfg["screenshots_folder"] = os.path.join(temp_dir.name, "screenshots")
    # schema 采集不需要 OCR 模型；禁用可避免打开面板时初始化 OpenVINO/NPU。
    cfg.pop("ocr", None)
    ok = None
    try:
        ok = OK(cfg)

        tasks = []
        seen = set()
        onetime_tasks = list(ok.task_executor.onetime_tasks or [])
        trigger_tasks = list(ok.task_executor.trigger_tasks or [])
        for t in onetime_tasks + trigger_tasks:
            module_name = t.__class__.__module__
            cls_name = t.__class__.__name__
            task_key = f"{module_name}::{cls_name}"
            if task_key in seen:
                continue
            seen.add(task_key)
            task_kind = "trigger" if t in trigger_tasks else "onetime"
            tasks.append((task_key, cls_name, task_kind, t))

        schemas = {}
        broken = []
        for task_key, cls_name, task_kind, task in tasks:
            try:
                default_config = dict(getattr(task, "default_config", {}) or {})
                runtime_config = dict(getattr(task, "config", {}) or {})
                config_type = dict(getattr(task, "config_type", {}) or {})
                config_description = dict(getattr(task, "config_description", {}) or {})
                config_groups = normalize_group_map(getattr(task, "default_config_group", {}) or {})
                group_selector, selector_groups = find_group_selector(config_type, config_groups)
                config_groups.update(selector_groups)
                fields = []
                ordered_keys = list(dict.fromkeys([
                    *runtime_config.keys(),
                    *default_config.keys(),
                    *config_type.keys(),
                ]))
                for key in ordered_keys:
                    dv = default_config.get(key, runtime_config.get(key))
                    type_meta = config_type.get(key)
                    resolved_type = type_meta.get("type") if isinstance(type_meta, dict) else None
                    if str(key).startswith("_"):
                        continue
                    if isinstance(type_meta, dict) and type_meta.get("hidden"):
                        continue
                    if resolved_type in ("button", "global"):
                        continue
                    if isinstance(type_meta, dict) and resolved_type is None and (
                        "buttons" in type_meta or "callback" in type_meta
                    ):
                        continue
                    jd = jsonable(dv)
                    saved_value = runtime_config.get(key, dv)
                    if dv is not None and not isinstance(saved_value, type(dv)):
                        saved_value = dv
                    jv = jsonable(saved_value)
                    jt = jsonable(type_meta)
                    if jd is UNSERIALIZABLE and jv is UNSERIALIZABLE and jt is UNSERIALIZABLE:
                        continue
                    # 值为 None 且没有可编辑类型的 key 通常只是配置组标题。
                    if jd is None and jv is None and not isinstance(jt, dict):
                        continue
                    fields.append({
                        "key": str(key),
                        "default": None if jd is UNSERIALIZABLE else jd,
                        "value": (None if jd is UNSERIALIZABLE else jd) if jv is UNSERIALIZABLE else jv,
                        "type": jt if isinstance(jt, dict) else None,
                        "desc": str(config_description.get(key, "")) if config_description.get(key) else "",
                    })
                schemas[task_key] = {
                    "fields": fields,
                    "displayName": str(getattr(task, "name", "") or cls_name),
                    "description": str(getattr(task, "description", "") or ""),
                    "kind": task_kind,
                    "configGroups": config_groups,
                    "groupSelector": group_selector,
                }
            except Exception as e:
                broken.append({"task": task_key, "error": f"{type(e).__name__}: {e}"})
                schemas[task_key] = {"fields": [], "broken": True, "error": f"{type(e).__name__}: {e}"}

        print(json.dumps({
            "ok": True,
            "total": len(tasks),
            "broken": broken,
            "schemas": schemas,
        }, ensure_ascii=False))
    finally:
        if ok is not None:
            ok.quit()
        temp_dir.cleanup()


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"}, ensure_ascii=False))
        sys.exit(1)
