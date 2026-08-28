#!/usr/bin/env python3
"""生成效果数据文件供VSCode插件使用"""

import json
import sys
import os

# 添加项目根目录到Python路径
project_root = "D:\\items\\project\\github_project\\ok-end-field"
sys.path.insert(0, project_root)

from src.data.effects import EffectType, EFFECT_DESCRIPTIONS

def generate_effects_data():
    """从effects.py生成效果数据"""
    effects = []
    for effect_type in EffectType:
        effects.append({
            "id": effect_type.value,
            "name": effect_type.name,
            "description": EFFECT_DESCRIPTIONS.get(effect_type, ""),
            "category": get_category(effect_type)
        })
    
    # 确保输出目录存在
    output_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'data')
    os.makedirs(output_dir, exist_ok=True)
    
    # 写入效果数据文件
    output_path = os.path.join(output_dir, 'effects.json')
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(effects, f, ensure_ascii=False, indent=2)
    
    print(f"Generated {len(effects)} effects to {output_path}")

def get_category(effect_type: EffectType) -> str:
    """根据ID前缀判断效果分类"""
    prefix = effect_type.value.split("_")[0]
    categories = {
        "ATTACH": "元素附着",
        "VULN": "元素脆弱",
        "STATUS": "异常状态",
        "STACK": "层数系统",
        "BUFF": "增益效果",
        "DEBUFF": "减益效果",
        "MECH": "特殊机制",
        "CONSUME": "消耗/清除",
        "CLEAR": "消耗/清除",
        "TRIGGER": "触发效果"
    }
    return categories.get(prefix, "其他")

if __name__ == "__main__":
    generate_effects_data()