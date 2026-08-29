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

    cfg = dict(config)
    cfg["use_gui"] = False
    ok = OK(cfg)
    ok.do_init()

    tasks = []
    seen = set()
    for t in list(ok.task_executor.onetime_tasks or []) + list(ok.task_executor.trigger_tasks or []):
        cls_name = t.__class__.__name__
        if cls_name in seen:
            continue
        seen.add(cls_name)
        tasks.append((cls_name, t))

    schemas = {}
    broken = []
    for cls_name, task in tasks:
        try:
            default_config = dict(getattr(task, "default_config", {}) or {})
            config_type = dict(getattr(task, "config_type", {}) or {})
            config_description = dict(getattr(task, "config_description", {}) or {})
            saved = {}
            try:
                saved = dict(getattr(task, "config", {}) or {})
            except Exception:
                pass
            fields = []
            for key, dv in default_config.items():
                jd = jsonable(dv)
                jv = jsonable(saved.get(key))
                jt = jsonable(config_type.get(key))
                if jd is None and jv is None and jt is None:
                    continue
                fields.append({
                    "key": str(key),
                    "default": jd if jd is not None else None,
                    "value": jv if jv is not None else (jd if jd is not None else None),
                    "type": jt if isinstance(jt, dict) else None,
                    "desc": str(config_description.get(key, "")) if config_description.get(key) else "",
                })
            schemas[cls_name] = {"fields": fields}
        except Exception as e:
            broken.append({"class": cls_name, "error": f"{type(e).__name__}: {e}"})
            schemas[cls_name] = {"fields": [], "broken": True, "error": f"{type(e).__name__}: {e}"}

    print(json.dumps({
        "ok": True,
        "total": len(tasks),
        "broken": broken,
        "schemas": schemas,
    }, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"}, ensure_ascii=False))
        sys.exit(1)
