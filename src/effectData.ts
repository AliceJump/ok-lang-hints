import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * 技能效果 ID -> 描述映射（解析 ok-end-field 的 src/data/effects.py）。
 *
 * effects.py 中定义了两部分：
 *   1. class EffectType(Enum)：成员名 = "值"（如 ATTACH_COLD = "ATTACH_COLD"）
 *   2. EFFECT_DESCRIPTIONS：EffectType.成员名: "中文描述"
 *
 * 该数据用于 EffectType.XXX / "effect_id": "XXX" 的 hover、补全与幽灵注释。
 */
export interface EffectEntry {
  id: string; // 效果 ID，如 ATTACH_COLD
  description: string; // 中文描述，如 敌人被施加寒冷元素
  category: string; // 分类，如 元素附着
}

/** 解析 effects.py 文本为效果 ID -> 描述映射（纯函数，便于单测） */
export function parseEffects(text: string): Map<string, EffectEntry> {
  const map = new Map<string, EffectEntry>();
  // 成员名 -> { 值, 记录时的分类 }
  const members = new Map<string, { value: string; category: string }>();
  const descs = new Map<string, string>(); // 成员名 -> 中文描述

  let category = '';
  // 忽略不构成分类的注释：docstring「效果类型。」、模块标题「效果ID系统定义」等
  const isCategoryLine = (c: string) =>
    c !== '' && !c.includes('。') && c !== '效果类型' && !c.startsWith('效果ID系统');

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    // 分类注释：如「# 元素附着」
    const cat = /^#\s*(.+?)\s*$/.exec(line);
    if (cat) {
      const c = cat[1].trim();
      if (isCategoryLine(c)) category = c;
      continue;
    }
    // 枚举成员：NAME = "VALUE"（行尾可带 # 注释）
    const mm = /^([A-Z][A-Z0-9_]*)\s*=\s*"([A-Z0-9_]+)"\s*(?:#.*)?$/.exec(line);
    if (mm && category) members.set(mm[1], { value: mm[2], category });
    // 描述映射：EffectType.NAME: "描述"（末尾可带逗号）
    const dm = /^EffectType\.([A-Z][A-Z0-9_]*)\s*:\s*"([^"]*)",?\s*$/.exec(line);
    if (dm) descs.set(dm[1], dm[2]);
  }

  for (const [name, { value, category: cat }] of members) {
    const desc = descs.get(name);
    if (desc !== undefined) {
      map.set(value, { id: value, description: desc, category: cat });
    }
  }
  return map;
}

/** 从 src/data/effects.py 加载效果 ID 数据（按 mtime 增量刷新） */
export class EffectData {
  private rootDir: string;
  private cache = new Map<string, EffectEntry>();
  private filePath = '';
  private mtime = 0;

  constructor(root: vscode.WorkspaceFolder | undefined) {
    this.rootDir = root ? root.uri.fsPath : '';
  }

  private effectsFile(): string {
    const rel =
      vscode.workspace.getConfiguration('okScriptToolkit').get<string>('effectsFile') ||
      'src/data/effects.py';
    return path.join(this.rootDir, rel);
  }

  refresh(force = false): void {
    if (!this.rootDir) return;
    const fp = this.effectsFile();
    if (!fs.existsSync(fp)) {
      if (force || this.filePath === fp) {
        this.cache.clear();
        this.filePath = fp;
        this.mtime = 0;
      }
      return;
    }
    let m = 0;
    try {
      m = fs.statSync(fp).mtimeMs;
    } catch {
      return;
    }
    if (!force && this.filePath === fp && this.mtime === m) return;
    this.filePath = fp;
    this.mtime = m;
    try {
      this.cache = parseEffects(fs.readFileSync(fp, 'utf-8'));
    } catch {
      // 跳过坏文件
    }
  }

  /** 全部效果 ID（补全用） */
  ids(): string[] {
    this.refresh();
    return [...this.cache.keys()].sort();
  }

  /** 查单个效果条目（hover 用） */
  entry(id: string): EffectEntry | undefined {
    this.refresh();
    return this.cache.get(id);
  }

  /** 分类列表 */
  categories(): string[] {
    this.refresh();
    const set = new Set<string>();
    for (const e of this.cache.values()) set.add(e.category);
    return [...set];
  }
}
