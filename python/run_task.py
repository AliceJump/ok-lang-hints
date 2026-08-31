# -*- coding: utf-8 -*-
"""在 ok-script 项目目录下运行单个任务（headless，不启动 GUI）。

用法（在项目目录下）:
    python run_task.py --task TaskClassName --task-module module.path --config-module src.config -- [额外参数]

参数覆盖通过环境变量 OK_LANG_HINTS_INJECT 传入:
    {"module.path::TaskClassName": {"key": value, ...}}

注入原理：猴子补丁 BaseTask.load_config —— 任务加载配置后、on_create() 前，
把插件侧 params 覆盖进 self.config（仅内存，不写 configs/*.json，不污染项目配置）。
参考 ok-end-field src/patches 的 monkey-patch 模式（functools.wraps + 类方法替换 + 幂等）。
"""
import argparse
import functools
import json
import os
import sys

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")


def apply_inject_patch(inject: dict) -> None:
    """把 inject={module::ClassName: {key: value}} 覆盖进目标任务配置。"""
    if not inject:
        return
    from ok.task.task import BaseTask

    original = BaseTask.load_config

    @functools.wraps(original)
    def patched_load_config(self, *args, **kwargs):
        original(self, *args, **kwargs)
        task_key = f"{self.__class__.__module__}::{self.__class__.__name__}"
        overrides = inject.get(task_key)
        if isinstance(overrides, dict):
            for key, value in overrides.items():
                if key in self.config:
                    # Config.__setitem__ 会立即写回 configs/*.json；直接调用 dict
                    # 基类实现，确保覆盖仅对当前进程生效。
                    dict.__setitem__(self.config, key, value)

    BaseTask.load_config = patched_load_config


def main():
    parser = argparse.ArgumentParser(description="运行 ok-script 单个任务（headless）")
    parser.add_argument("--task", required=True, help="任务类名")
    parser.add_argument("--task-module", required=True, help="任务模块路径")
    parser.add_argument("--config-module", default="src.config", help="config 模块路径，如 src.config 或 config")
    args, extra_args = parser.parse_known_args()
    if extra_args and extra_args[0] == "--":
        extra_args = extra_args[1:]

    # 读参数覆盖（环境变量 -> 不炸）
    inject = {}
    raw_inject = os.environ.get("OK_LANG_HINTS_INJECT", "")
    if raw_inject:
        try:
            inject = json.loads(raw_inject)
        except Exception:
            inject = {}

    sys.path.insert(0, ".")

    # 参数注入补丁（必须在 import 任务前装好）
    apply_inject_patch(inject)

    config_module = __import__(args.config_module, fromlist=["config"])
    config = config_module.config

    # 过滤任务注册表：只保留目标任务，避免 TaskManager 加载其他
    # 有导入问题的任务（如 ok-end-field 的 characters 包问题）导致整体失败
    # 注意：不能直接把 trigger_tasks 清空——若目标任务本身是 trigger 任务，
    # OK.get_task 会先查 onetime_tasks 再查 trigger_tasks，清空会导致找不到。
    config = dict(config)
    config["check_mutex"] = False
    task_name = args.task
    task_module = args.task_module
    config["onetime_tasks"] = [
        t for t in config.get("onetime_tasks", []) if t[0] == task_module and t[1] == task_name
    ]
    config["trigger_tasks"] = [
        t for t in config.get("trigger_tasks", []) if t[0] == task_module and t[1] == task_name
    ]

    # 只把显式透传参数交给 ok-script，避免辅助脚本自身参数与框架 argparse 冲突。
    saved_argv = sys.argv[:]
    sys.argv = [saved_argv[0], *extra_args]

    from ok import run_task

    try:
        run_task(config, task=task_name)
    finally:
        sys.argv = saved_argv


if __name__ == "__main__":
    main()
