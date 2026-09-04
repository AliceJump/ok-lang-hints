import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { decodeRgba, encodePngRgb } from './pngCrop';
import { tr } from './localization';

/* ---------------- COCO 数据类型 ---------------- */

export interface CocoImage {
  id: number;
  file_name: string;
  width: number;
  height: number;
}

export interface CocoAnnotation {
  id: number;
  image_id: number;
  category_id: number;
  bbox: [number, number, number, number]; // [x, y, w, h]
  area: number;
  iscrowd: number;
}

export interface CocoCategory {
  id: number;
  name: string;
  supercategory: string;
}

export interface CocoData {
  images: CocoImage[];
  annotations: CocoAnnotation[];
  categories: CocoCategory[];
}

/* ---------------- 文件名归一化（兼容大小写/扩展名） ---------------- */

export function filenameKey(name: string): string {
  return path.basename(name).toLowerCase().replace(/\.[^.]+$/, '');
}

/* ---------------- 模板素材数据管理 ---------------- */

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.bmp', '.webp']);
const TEMPLATE_FOLDER = 'ok_templates';
const COCO_JSON = 'coco_annotations.json';

export class TemplateAssetData {
  private rootDir: string;
  private cocoData: CocoData = { images: [], annotations: [], categories: [] };
  private cocoPath: string;
  private templateFolder: string;
  private _dirty = false;

  constructor(root: vscode.WorkspaceFolder | string | undefined) {
    this.rootDir = typeof root === 'string' ? root : root ? root.uri.fsPath : '';
    this.templateFolder = path.join(this.rootDir, TEMPLATE_FOLDER);
    this.cocoPath = path.join(this.templateFolder, COCO_JSON);
  }

  /** Add an image file to COCO data (static helper for external callers). */
  static async addImageToCoco(imagePath: string): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) throw new Error(tr('noWorkspaceFolder'));
    const data = new TemplateAssetData(folder);
    await data.load();
    data.addImageEntry(imagePath, 0, 0);
    // Read actual dimensions if PNG
    try {
      const buf = fs.readFileSync(imagePath);
      if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) {
        const w = buf.readUInt32BE(16);
        const h = buf.readUInt32BE(20);
        const img = data.cocoData.images.find(i => i.file_name === path.basename(imagePath));
        if (img) { img.width = w; img.height = h; }
      }
    } catch { /* ignore */ }
    data.save();
  }

  get root(): string { return this.rootDir; }
  get templatesDir(): string { return this.templateFolder; }

  /* ---------- 初始化/加载 ---------- */

  ensureTemplateFolder(): string {
    if (!fs.existsSync(this.templateFolder)) {
      fs.mkdirSync(this.templateFolder, { recursive: true });
    }
    return this.templateFolder;
  }

  load(): CocoData {
    this.ensureTemplateFolder();
    if (fs.existsSync(this.cocoPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.cocoPath, 'utf-8'));
        this.cocoData = {
          images: raw.images ?? [],
          annotations: raw.annotations ?? [],
          categories: raw.categories ?? [],
        };
      } catch {
        this.cocoData = { images: [], annotations: [], categories: [] };
      }
    } else {
      this.cocoData = { images: [], annotations: [], categories: [] };
    }
    this._dirty = false;
    return this.cocoData;
  }

  save(): void {
    this.ensureTemplateFolder();
    fs.writeFileSync(this.cocoPath, JSON.stringify(this.cocoData, null, 2), 'utf-8');
    this._dirty = false;
  }

  get data(): CocoData { return this.cocoData; }

  /* ---------- 图片列表 ---------- */

  listImages(): string[] {
    this.ensureTemplateFolder();
    try {
      return fs.readdirSync(this.templateFolder)
        .filter((f) => IMAGE_EXTS.has(path.extname(f).toLowerCase()))
        .sort((a, b) => {
          const sa = fs.statSync(path.join(this.templateFolder, a));
          const sb = fs.statSync(path.join(this.templateFolder, b));
          return sb.mtimeMs - sa.mtimeMs; // 最新的在前
        })
        .map((f) => path.join(this.templateFolder, f));
    } catch {
      return [];
    }
  }

  /* ---------- 图片名称管理 ---------- */

  nextImageName(): string {
    const existing = new Set(
      this.cocoData.images.map((img) => path.basename(img.file_name, path.extname(img.file_name)))
    );
    let i = 1;
    while (existing.has(String(i))) i++;
    return String(i);
  }

  /* ---------- COCO 图片操作 ---------- */

  getImageEntryForPath(imagePath: string): CocoImage | undefined {
    const key = filenameKey(imagePath);
    return this.cocoData.images.find((img) => filenameKey(img.file_name) === key);
  }

  getImageId(imagePath: string): number | undefined {
    return this.getImageEntryForPath(imagePath)?.id;
  }

  addImageEntry(imagePath: string, width: number, height: number): void {
    const filename = path.basename(imagePath);
    if (this.getImageEntryForPath(imagePath)) return;
    let maxId = 0;
    for (const img of this.cocoData.images) {
      if (img.id > maxId) maxId = img.id;
    }
    this.cocoData.images.push({ id: maxId + 1, file_name: filename, width, height });
    this._dirty = true;
  }

  removeImageEntry(imagePath: string): void {
    const imageId = this.getImageId(imagePath);
    if (imageId === undefined) return;
    this.cocoData.images = this.cocoData.images.filter((img) => img.id !== imageId);
    this.cocoData.annotations = this.cocoData.annotations.filter((ann) => ann.image_id !== imageId);
    this._cleanupCategories();
    this._dirty = true;
  }

  /* ---------- COCO 标注操作 ---------- */

  getAnnotationsForImage(imagePath: string): Array<CocoAnnotation & { categoryName: string }> {
    const imageId = this.getImageId(imagePath);
    if (imageId === undefined) return [];
    return this.cocoData.annotations
      .filter((ann) => ann.image_id === imageId)
      .map((ann) => ({
        ...ann,
        categoryName: this.getCategoryName(ann.category_id) || String(ann.category_id),
      }));
  }

  setAnnotationsForImage(imagePath: string, annotations: Array<{ category: string; x: number; y: number; w: number; h: number }>): void {
    const imageId = this.getImageId(imagePath);
    if (imageId === undefined) return;
    // 移除旧标注
    this.cocoData.annotations = this.cocoData.annotations.filter((ann) => ann.image_id !== imageId);
    // 添加新标注
    let maxAnnId = 0;
    for (const ann of this.cocoData.annotations) {
      if (ann.id > maxAnnId) maxAnnId = ann.id;
    }
    for (const ann of annotations) {
      const catId = this._getOrCreateCategoryId(ann.category);
      maxAnnId++;
      this.cocoData.annotations.push({
        id: maxAnnId,
        image_id: imageId,
        category_id: catId,
        bbox: [ann.x, ann.y, ann.w, ann.h],
        area: ann.w * ann.h,
        iscrowd: 0,
      });
    }
    this._cleanupCategories();
    this._dirty = true;
  }

  /* ---------- 分类操作 ---------- */

  getCategoryName(catId: number): string | undefined {
    return this.cocoData.categories.find((c) => c.id === catId)?.name;
  }

  _getOrCreateCategoryId(name: string): number {
    const existing = this.cocoData.categories.find((c) => c.name === name);
    if (existing) return existing.id;
    let maxId = 0;
    for (const c of this.cocoData.categories) {
      if (c.id > maxId) maxId = c.id;
    }
    const newId = maxId + 1;
    this.cocoData.categories.push({ id: newId, name, supercategory: '' });
    return newId;
  }

  _cleanupCategories(): void {
    const usedIds = new Set(this.cocoData.annotations.map((ann) => ann.category_id));
    this.cocoData.categories = this.cocoData.categories.filter((c) => usedIds.has(c.id));
  }

  /* ---------- 获取图片关联的分类名 ---------- */

  getCategoriesForImage(imagePath: string): string[] {
    const imageId = this.getImageId(imagePath);
    if (imageId === undefined) return [];
    const catIds = new Set(
      this.cocoData.annotations
        .filter((ann) => ann.image_id === imageId)
        .map((ann) => ann.category_id)
    );
    return this.cocoData.categories
      .filter((c) => catIds.has(c.id))
      .map((c) => c.name);
  }

  /* ---------- 删除图片文件和COCO数据 ---------- */

  deleteImage(imagePath: string): boolean {
    try {
      if (fs.existsSync(imagePath)) fs.unlinkSync(imagePath);
      this.removeImageEntry(imagePath);
      this.save();
      return true;
    } catch {
      return false;
    }
  }

  /* ---------- 保存到项目assets（bin-packing + 枚举） ---------- */

  /**
   * 将 ok_templates 中的图片+标注导出到项目 assets 目录。
   *
   * 对齐 ok-script FeatureSet.compress_coco() 语义：
   * - 无标注图片：直接复制原图。
   * - 有标注图片：按原始 (width × height) 分组，同尺寸原图的互不重叠 bbox 打包到
   *   同一张白色 Canvas（原坐标粘贴），重叠 bbox 分到不同 page。
   * - COCO annotation bbox 保持原始坐标不变。
   * - 生成的 COCO image file_name 指向打包后的 PNG。
   */
  saveToAssets(targetFolder: string, generateEnum = false, enumPath?: string): void {
    const targetImagesDir = path.join(targetFolder, 'images');

    // 清空目标目录中的旧图片（重新生成前清理）
    if (fs.existsSync(targetImagesDir)) {
      for (const f of fs.readdirSync(targetImagesDir)) {
        try { fs.unlinkSync(path.join(targetImagesDir, f)); } catch { /* ignore */ }
      }
    }
    if (!fs.existsSync(targetImagesDir)) fs.mkdirSync(targetImagesDir, { recursive: true });

    const newImages: CocoImage[] = [];
    const newAnnotations: CocoAnnotation[] = [];
    let nextImageId = 1;
    let nextAnnId = 1;

    // ── 1. 只处理有标注的图片（无标注的原图不放入 assets） ──
    const annotatedImages: CocoImage[] = [];

    for (const img of this.cocoData.images) {
      const hasAnnotations = this.cocoData.annotations.some((a) => a.image_id === img.id);
      if (hasAnnotations) {
        annotatedImages.push(img);
      }
    }

    // ── 2. 有标注图片：按原始尺寸分组，bin-packing 到 Canvas ──
    //    对齐 ok-script compress_coco: 同尺寸原图的互不重叠 bbox 打包到同一张 Canvas。
    type AnnotatedEntry = { img: CocoImage; ann: CocoAnnotation };
    const dimGroups = new Map<string, AnnotatedEntry[]>();

    for (const img of annotatedImages) {
      const src = path.join(this.templateFolder, img.file_name);
      if (!fs.existsSync(src)) continue;

      // 从原图读取实际宽高（优先使用 COCO 中记录的值，但以实际文件为准）
      let imgW = img.width;
      let imgH = img.height;
      try {
        const buf = fs.readFileSync(src);
        const dims = decodeRgba(buf);
        imgW = dims.width;
        imgH = dims.height;
      } catch {
        // 读取失败则使用 COCO 记录值
      }

      const annotations = this.cocoData.annotations.filter((a) => a.image_id === img.id);
      for (const ann of annotations) {
        const dimKey = `${imgW}×${imgH}`;
        if (!dimGroups.has(dimKey)) dimGroups.set(dimKey, []);
        dimGroups.get(dimKey)!.push({ img: { ...img, width: imgW, height: imgH }, ann });
      }
    }

    // 每个尺寸组内执行 bin-packing
    for (const [_dimKey, entries] of dimGroups) {
      // 从 entries 推导画布尺寸（同组所有 entry 的 img 宽高相同）
      const W = entries[0].img.width;
      const H = entries[0].img.height;

      // 构建每张原图的 bbox 区域列表
      const imgRects = new Map<number, Array<[number, number, number, number]>>();
      for (const e of entries) {
        const [bx, by, bw, bh] = e.ann.bbox.map(Math.round) as [number, number, number, number];
        const rects = imgRects.get(e.img.id) ?? [];
        rects.push([bx, by, bx + bw, by + bh]); // 存储 [x1,y1,x2,y2] 用于重叠检测
        imgRects.set(e.img.id, rects);
      }

      // 所有唯一原图 id
      const allImgIds = [...new Set(entries.map((e) => e.img.id))];

      // Bin-packing: 将原图分配到 page，互不重叠的原图可共用同一 page
      const pages: Array<{ imgIds: number[]; occupancy: Array<[number, number, number, number]> }> = [];

      for (const imgId of allImgIds) {
        const rects = imgRects.get(imgId) ?? [];
        let assigned = false;

        for (const page of pages) {
          // 检测该原图的所有 bbox 是否与 page 已有区域冲突
          let conflict = false;
          for (const cRect of rects) {
            for (const pRect of page.occupancy) {
              if (cRect[0] < pRect[2] && cRect[2] > pRect[0] &&
                  cRect[1] < pRect[3] && cRect[3] > pRect[1]) {
                conflict = true;
                break;
              }
            }
            if (conflict) break;
          }
          if (!conflict) {
            page.imgIds.push(imgId);
            page.occupancy.push(...rects);
            assigned = true;
            break;
          }
        }

        if (!assigned) {
          pages.push({ imgIds: [imgId], occupancy: [...rects] });
        }
      }

      // 为每个 page 生成打包 PNG
      for (const page of pages) {
        // 白色画布
        const canvasRgba = Buffer.alloc(W * H * 4, 255); // 全白 (RGBA 255,255,255,255)

        // 从每个原图复制对应 bbox ROI 到 Canvas
        for (const imgId of page.imgIds) {
          const srcImg = entries.find((e) => e.img.id === imgId)!.img;
          const src = path.join(this.templateFolder, srcImg.file_name);
          try {
            const buf = fs.readFileSync(src);
            const srcDecoded = decodeRgba(buf);
            const srcAnnotations = entries.filter((e) => e.img.id === imgId);
            for (const e of srcAnnotations) {
              const [bx, by, bw, bh] = e.ann.bbox.map(Math.round);
              const x1 = Math.max(0, bx);
              const y1 = Math.max(0, by);
              const x2 = Math.min(W, bx + bw);
              const y2 = Math.min(H, by + bh);
              if (x2 > x1 && y2 > y1) {
                for (let y = y1; y < y2; y++) {
                  const srcStart = (y * srcDecoded.width + x1) * 4;
                  const dstStart = (y * W + x1) * 4;
                  srcDecoded.rgba.copy(canvasRgba, dstStart, srcStart, srcStart + (x2 - x1) * 4);
                }
              }
            }
          } catch {
            // 源图读取失败，跳过
          }
        }

        // 编码并写入打包 PNG（使用 RGB 编码器，对齐 ok-script 压缩效果）
        const pageFileName = `${nextImageId}.png`;
        const pagePng = encodePngRgb(W, H, canvasRgba);
        const pageDst = path.join(targetImagesDir, pageFileName);
        fs.writeFileSync(pageDst, pagePng);

        // file_name = 从 COCO JSON 到打包 PNG 的相对路径（对齐 ok-script compress_coco）
        // COCO JSON 在 targetFolder/，图片在 targetFolder/images/，所以相对路径固定为 images/{id}.png
        const finalRelPath = `images/${pageFileName}`;

        const packedImgId = nextImageId++;
        newImages.push({
          id: packedImgId,
          file_name: finalRelPath,
          width: W,
          height: H,
        });

        // COCO annotations: 保持原始 bbox 坐标，仅更新 image_id 指向打包图
        const pageImgIds = new Set(page.imgIds);
        for (const e of entries) {
          if (!pageImgIds.has(e.img.id)) continue;
          const [bx, by, bw, bh] = e.ann.bbox.map(Math.round) as [number, number, number, number];
          newAnnotations.push({
            id: nextAnnId++,
            image_id: packedImgId,
            category_id: e.ann.category_id,
            bbox: [bx, by, bw, bh],
            area: bw * bh,
            iscrowd: 0,
          });
        }
      }
    }

    // ── 4. 构建并写入 COCO JSON ──
    const croppedCoco: CocoData = {
      images: newImages,
      annotations: newAnnotations,
      categories: [...this.cocoData.categories],
    };

    // 清理无引用的分类
    const usedCatIds = new Set(newAnnotations.map((a) => a.category_id));
    croppedCoco.categories = croppedCoco.categories.filter((c) => usedCatIds.has(c.id));

    // 清理旧的 COCO JSON 文件
    try {
      for (const f of fs.readdirSync(targetFolder)) {
        if (f.toLowerCase().endsWith('.json')) {
          try { fs.unlinkSync(path.join(targetFolder, f)); } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }

    const cocoTarget = path.join(targetFolder, COCO_JSON);
    fs.writeFileSync(cocoTarget, JSON.stringify(croppedCoco, null, 2), 'utf-8');

    // Generate label enum if requested
    if (generateEnum) {
      const labels = croppedCoco.categories.map(c => c.name).sort();
      const enumFile = enumPath || path.join(targetFolder, 'LabelEnum.py');
      this.generateLabelEnum(enumFile, labels);
    }
  }

  /** Generate a Python enum file from category labels. */
  private generateLabelEnum(filePath: string, labels: string[]): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const className = path.basename(filePath, '.py');
    let content = 'from enum import Enum\n\n\n';
    content += `class ${className}(str, Enum):\n`;
    for (const label of labels) {
      content += `    ${label} = '${label}'\n`;
    }
    fs.writeFileSync(filePath, content, 'utf-8');
  }

  /* ---------- 添加截图（base64 PNG） ---------- */

  addScreenshot(base64Png: string): string | undefined {
    try {
      this.ensureTemplateFolder();
      const name = this.nextImageName();
      const filePath = path.join(this.templateFolder, `${name}.png`);
      const buf = Buffer.from(base64Png, 'base64');
      fs.writeFileSync(filePath, buf);

      // 读取图片尺寸
      const dims = this.readPngDimensions(buf);
      this.addImageEntry(filePath, dims.width, dims.height);
      this.save();
      return filePath;
    } catch {
      return undefined;
    }
  }

  /* ---------- 简易PNG尺寸读取 ---------- */

  private readPngDimensions(buf: Buffer): { width: number; height: number } {
    if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) {
      return { width: 0, height: 0 };
    }
    return {
      width: buf.readUInt32BE(16),
      height: buf.readUInt32BE(20),
    };
  }
}
