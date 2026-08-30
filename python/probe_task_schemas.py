# -*- coding: utf-8 -*-
"""全量 import 采集 ok-script 项目所有任务的配置 schema。

复用 ok-script 的 OK(config) + TaskManager 初始化来实例化任务，拿到经过继承链
合并的真实 default_config / config_type / config_description / 已保存 config。
逐任务 try/except 容错，坏任务标记 broken，不影响其他任务。

用法: python probe_task_schemas.py <project_dir>
输出(最后一行 JSON): {"ok": true, "total": N, "broken": [...], "schemas": {...}}
"""
import json
import os
import sys
import tempfile

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")


def jsonable(v):
    """转成可 JSON 序列化形式；函数/对象/Enum 等返回 None（跳过）。"""
    if v is None or isinstance(v, (bool, int, float, str)):
        return v
    if isinstance(v, (list, tuple)):
        out = []
        for x in v:
            jx = jsonable(x)
            if jx is not None:
                out.append(jx)
        return out
    if isinstance(v, dict):
        out = {}
        for k, x in v.items():
            jx = jsonable(x)
            if jx is not None:
                out[str(k)] = jx
        return out
    return None


def load_saved_config(project_dir, config_folder, class_name):
    """只读加载项目现有任务配置，避免用 Config 实例写回目标项目。"""
    config_path = os.path.join(project_dir, config_folder, f"{class_name}.json")
    try:
        with open(config_path, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError, TypeError):
        return {}


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "缺少 project_dir 参数"}, ensure_ascii=False))
        sys.exit(1)
    project_dir = sys.argv[1]
    sys.path.insert(0, project_dir)
    os.chdir(project_dir)

    try:
        from src.config import config
    except Exception:
        from config import config

    from ok import OK

    source_config_folder = config.get("config_folder") or "configs"
    temp_dir = tempfile.TemporaryDirectory(prefix="ok-lang-hints-probe-")
    cfg = dict(config)
    cfg["use_gui"] = False
    cfg["check_mutex"] = False
    cfg["custom_tasks"] = False
    cfg["config_folder"] = os.path.join(temp_dir.name, "configs")
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
                config_type = dict(getattr(task, "config_type", {}) or {})
                config_description = dict(getattr(task, "config_description", {}) or {})
                saved = load_saved_config(project_dir, source_config_folder, cls_name)
                fields = []
                for key, dv in default_config.items():
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
                    saved_value = saved.get(key, dv)
                    if not isinstance(saved_value, type(dv)):
                        saved_value = dv
                    jv = jsonable(saved_value)
                    jt = jsonable(type_meta)
                    if jd is None and jv is None and jt is None:
                        continue
                    fields.append({
                        "key": str(key),
                        "default": jd if jd is not None else None,
                        "value": jv if jv is not None else (jd if jd is not None else None),
                        "type": jt if isinstance(jt, dict) else None,
                        "desc": str(config_description.get(key, "")) if config_description.get(key) else "",
                    })
                schemas[task_key] = {
                    "fields": fields,
                    "displayName": str(getattr(task, "name", "") or cls_name),
                    "description": str(getattr(task, "description", "") or ""),
                    "kind": task_kind,
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
