import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { cropTemplateThumbFile } from './pngCrop';

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
    if (!folder) throw new Error('No workspace folder');
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

  /* ---------- 保存到项目assets（裁剪+枚举） ---------- */

  saveToAssets(targetFolder: string, generateEnum = false, enumPath?: string): void {
    const targetImagesDir = path.join(targetFolder, 'images');
    if (!fs.existsSync(targetImagesDir)) fs.mkdirSync(targetImagesDir, { recursive: true });

    // 裁剪模式：对每张图片的每个标注区域进行裁剪，保存为独立文件
    const newImages: CocoImage[] = [];
    const newAnnotations: CocoAnnotation[] = [];
    let nextImageId = 1;
    let nextAnnId = 1;

    for (const img of this.cocoData.images) {
      const src = path.join(this.templateFolder, img.file_name);
      if (!fs.existsSync(src)) continue;

      const annotations = this.cocoData.annotations.filter((a) => a.image_id === img.id);
      if (annotations.length === 0) {
        // 无标注的图片：直接复制原图
        const dst = path.join(targetImagesDir, img.file_name);
        fs.copyFileSync(src, dst);
        newImages.push({ ...img, id: nextImageId++ });
        continue;
      }

      // 有标注：逐个裁剪标注区域为独立图片
      for (const ann of annotations) {
        const [bx, by, bw, bh] = ann.bbox;
        const cropBbox: [number, number, number, number] = [
          Math.round(bx), Math.round(by), Math.round(bw), Math.round(bh),
        ];
        // 用 pngCrop 的裁剪函数生成缩略图文件（targetHeight=0 表示保持原始尺寸比例）
        const cropFile = cropTemplateThumbFile(src, cropBbox, targetImagesDir, 0);
        if (!cropFile) continue;

        const baseName = path.basename(img.file_name, path.extname(img.file_name));
        const cropFileName = `${baseName}_${cropBbox[0]}_${cropBbox[1]}_${cropBbox[2]}_${cropBbox[3]}.png`;
        const cropDst = path.join(targetImagesDir, cropFileName);
        // cropTemplateThumbFile 已写入文件，重命名为带坐标的名字
        if (cropFile !== cropDst) {
          try {
            if (fs.existsSync(cropDst)) fs.unlinkSync(cropDst);
            fs.renameSync(cropFile, cropDst);
          } catch {
            // rename 失败则复制
            try { fs.copyFileSync(cropFile, cropDst); } catch { continue; }
          }
        }

        const newImgId = nextImageId++;
        newImages.push({
          id: newImgId,
          file_name: cropFileName,
          width: Math.round(bw),
          height: Math.round(bh),
        });
        newAnnotations.push({
          id: nextAnnId++,
          image_id: newImgId,
          category_id: ann.category_id,
          bbox: [0, 0, Math.round(bw), Math.round(bh)],
          area: Math.round(bw) * Math.round(bh),
          iscrowd: 0,
        });
      }
    }

    // 构建裁剪后的 COCO 数据
    const croppedCoco: CocoData = {
      images: newImages,
      annotations: newAnnotations,
      categories: [...this.cocoData.categories],
    };

    // 清理无引用的分类
    const usedCatIds = new Set(newAnnotations.map((a) => a.category_id));
    croppedCoco.categories = croppedCoco.categories.filter((c) => usedCatIds.has(c.id));

    // 写入 COCO JSON
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
