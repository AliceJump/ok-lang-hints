import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/** COCO 中一个 feature 模板条目：来源原图 + 裁剪框 */
export interface FeatureTemplate {
  name: string;
  imagePath: string; // 原图绝对路径
  bbox: [number, number, number, number]; // [x, y, w, h]
  width: number;
  height: number;
}

/** 解析 assets/coco_annotations.json（COCO 格式）为 feature -> 模板映射 */
export class FeatureData {
  private rootDir: string;
  private cache = new Map<string, FeatureTemplate>();
  private cocoMtimes = new Map<string, number>();

  constructor(root: vscode.WorkspaceFolder | string | undefined) {
    this.rootDir = typeof root === 'string' ? root : root ? root.uri.fsPath : '';
  }

  /** 需要扫描的 coco 标注文件列表（主库 + 可选的 ok_tasks 扩展库） */
  private cocoFiles(): string[] {
    const list = [path.join(this.rootDir, 'assets', 'coco_annotations.json')];
    const okTasks = path.join(this.rootDir, 'ok_tasks', 'assets', 'coco_annotations.json');
    if (fs.existsSync(okTasks)) list.push(okTasks);
    return list;
  }

  refresh(force = false): void {
    if (!this.rootDir) return;
    if (force) {
      this.cache.clear();
      this.cocoMtimes.clear();
    }
    for (const cocoPath of this.cocoFiles()) {
      if (!fs.existsSync(cocoPath)) continue;
      let mtime = 0;
      try {
        mtime = fs.statSync(cocoPath).mtimeMs;
      } catch {
        continue;
      }
      if (!force && this.cocoMtimes.get(cocoPath) === mtime) continue;
      this.cocoMtimes.set(cocoPath, mtime);
      try {
        const data = JSON.parse(fs.readFileSync(cocoPath, 'utf-8'));
        this.loadCoco(cocoPath, data);
      } catch {
        // 跳过坏文件
      }
    }
  }

  private loadCoco(cocoPath: string, data: any): void {
    if (!data || typeof data !== 'object') return;
    const cocoFolder = path.dirname(cocoPath);
    const imageMap = new Map<number, string>();
    for (const img of data['images'] ?? []) {
      if (img && typeof img.id === 'number' && typeof img.file_name === 'string') {
        imageMap.set(img.id, path.join(cocoFolder, img.file_name));
      }
    }
    const categoryMap = new Map<number, string>();
    for (const cat of data['categories'] ?? []) {
      if (cat && typeof cat.id === 'number' && typeof cat.name === 'string') {
        categoryMap.set(cat.id, cat.name);
      }
    }
    for (const ann of data['annotations'] ?? []) {
      const name = categoryMap.get(ann?.category_id);
      const imagePath = imageMap.get(ann?.image_id);
      if (!name || !imagePath || !Array.isArray(ann?.bbox) || ann.bbox.length < 4) continue;
      const [x, y, w, h] = ann.bbox.map((n: number) => Math.round(n));
      if (w <= 0 || h <= 0) continue;
      this.cache.set(name, {
        name,
        imagePath,
        bbox: [x, y, w, h],
        width: w,
        height: h,
      });
    }
  }

  names(): string[] {
    this.refresh();
    return [...this.cache.keys()].sort();
  }

  entry(name: string): FeatureTemplate | undefined {
    this.refresh();
    return this.cache.get(name);
  }

  /** 返回全部模板（供后台预热裁剪缓存） */
  all(): FeatureTemplate[] {
    this.refresh();
    return [...this.cache.values()];
  }

  /** 工作区根目录（供原图映射等使用） */
  get root(): string {
    return this.rootDir;
  }
}

/* ---------------- ok_templates 原图反查（labelme json 索引） ---------------- */

/**
 * ok-script 的 ok_templates 目录里，N.png 是原始截图、N.json 是对应的 labelme 标注。
 * coco 的 assets/images/N.png 与 ok_templates/N.png 编号并不对应，
 * 必须按「模板名 + 标注坐标」在 labelme json 中反查真正的原图。
 */

interface LabelmeShape {
  label?: string;
  shape_type?: string;
  points?: number[][];
}

interface LabelmeIndex {
  builtAt: number;
  /** `${label}|${x},${y}` → 原图绝对路径（精确坐标匹配） */
  byKey: Map<string, string>;
  /** label → 原图绝对路径（按模板名直接匹配，无坐标歧义时使用） */
  byName: Map<string, string>;
}

const labelmeIndexes = new Map<string, LabelmeIndex>();
const LABELME_TTL_MS = 30_000;

function buildLabelmeIndex(rootDir: string): LabelmeIndex {
  const byKey = new Map<string, string>();
  const byName = new Map<string, string>();
  const dirs = [
    path.join(rootDir, 'ok_templates'),
    path.join(rootDir, 'ok_tasks', 'ok_templates'),
  ];
  for (const dir of dirs) {
    let files: string[] = [];
    try {
      if (!fs.existsSync(dir)) continue;
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    } catch {
      continue;
    }
    for (const f of files) {
      const jsonPath = path.join(dir, f);
      const pngPath = path.join(dir, f.replace(/\.json$/, '.png'));
      try {
        if (!fs.existsSync(pngPath)) continue;
        const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
        const shapes: LabelmeShape[] = Array.isArray(data?.shapes) ? data.shapes : [];
        for (const s of shapes) {
          if (!s || s.shape_type !== 'rectangle' || typeof s.label !== 'string') continue;
          const pts = s.points;
          if (!Array.isArray(pts) || pts.length < 2) continue;
          const xs = pts.map((p) => p[0]);
          const ys = pts.map((p) => p[1]);
          const x = Math.round(Math.min(...xs));
          const y = Math.round(Math.min(...ys));
          byKey.set(`${s.label}|${x},${y}`, pngPath);
          // 按模板名索引：每个模板名在 labelme 中只出现一次（无多图歧义）
          if (!byName.has(s.label)) byName.set(s.label, pngPath);
        }
      } catch {
        // 坏文件跳过
      }
    }
  }
  return { builtAt: Date.now(), byKey, byName };
}

function getLabelmeIndex(rootDir: string): LabelmeIndex {
  const hit = labelmeIndexes.get(rootDir);
  if (hit && Date.now() - hit.builtAt < LABELME_TTL_MS) return hit;
  const fresh = buildLabelmeIndex(rootDir);
  labelmeIndexes.set(rootDir, fresh);
  return fresh;
}

/**
 * 按「模板名 + bbox 左上角」反查 ok_templates 中的原始截图。
 * 查找优先级：
 *   1. 精确坐标匹配（`label|x,y`）
 *   2. 模板名直接匹配（每个模板在 labelme 中只出现一次，无歧义）
 *   3. 遍历所有坐标 key 找同名片段（兼容边界情况）
 */
export function findOkTemplateOriginal(
  rootDir: string,
  name: string,
  bbox: [number, number, number, number],
): string | undefined {
  if (!rootDir) return undefined;
  const idx = getLabelmeIndex(rootDir);
  // 1. 精确坐标匹配
  const exact = idx.byKey.get(`${name}|${bbox[0]},${bbox[1]}`);
  if (exact) return exact;
  // 2. 模板名直接匹配（最可靠，每个模板只出现在一张截图中）
  const byName = idx.byName.get(name);
  if (byName) return byName;
  // 3. 兜底：遍历所有 key 找同名片段
  const hits = new Set<string>();
  for (const [k, v] of idx.byKey) {
    if (k.startsWith(`${name}|`)) hits.add(v);
  }
  return hits.size === 1 ? [...hits][0] : undefined;
}
