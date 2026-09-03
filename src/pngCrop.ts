import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as zlib from 'zlib';
import { findOkTemplateOriginal } from './featureData';

/** 极简 PNG 解码/裁剪/编码：从原图按 bbox 裁出模板小图，返回 data URL。 */

interface PngMeta {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer, start = 0, end = buf.length): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function parsePng(buf: Buffer): { meta: PngMeta; idat: Buffer } {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) {
    throw new Error('not a png');
  }
  let meta: PngMeta | null = null;
  const idat: Buffer[] = [];
  let offset = 8;
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      meta = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
      };
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  if (!meta) throw new Error('missing IHDR');
  return { meta, idat: Buffer.concat(idat) };
}

/** 每像素字节数（仅 8-bit 及常见格式） */
function bytesPerPixel(colorType: number): number {
  switch (colorType) {
    case 0: return 1; // 灰度
    case 2: return 3; // RGB
    case 3: return 1; // 调色板索引
    case 4: return 2; // 灰度+alpha
    case 6: return 4; // RGBA
    default: throw new Error(`unsupported colorType ${colorType}`);
  }
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** 解码 PNG 为 RGBA8 像素（Buffer, w*h*4） */
export function decodeRgba(buf: Buffer): { width: number; height: number; rgba: Buffer } {
  const { meta, idat } = parsePng(buf);
  if (meta.bitDepth !== 8) throw new Error(`unsupported bitDepth ${meta.bitDepth}`);
  const { width, height, colorType } = meta;
  const bpp = bytesPerPixel(colorType);

  const raw = zlib.inflateSync(idat);
  const stride = width * bpp;
  const rgba = Buffer.alloc(width * height * 4);

  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    const filter = raw[rowStart];
    const row = raw.subarray(rowStart + 1, rowStart + 1 + stride);
    const recon = Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? recon[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = row[i];
      switch (filter) {
        case 0: break;
        case 1: v = (v + a) & 0xff; break;
        case 2: v = (v + b) & 0xff; break;
        case 3: v = (v + ((a + b) >> 1)) & 0xff; break;
        case 4: v = (v + paeth(a, b, c)) & 0xff; break;
        default: throw new Error(`unsupported filter ${filter}`);
      }
      recon[i] = v;
    }
    // 归一化到 RGBA
    for (let x = 0; x < width; x++) {
      const si = x * bpp;
      const di = (y * width + x) * 4;
      if (colorType === 6) {
        rgba[di] = recon[si];
        rgba[di + 1] = recon[si + 1];
        rgba[di + 2] = recon[si + 2];
        rgba[di + 3] = recon[si + 3];
      } else if (colorType === 2) {
        rgba[di] = recon[si];
        rgba[di + 1] = recon[si + 1];
        rgba[di + 2] = recon[si + 2];
        rgba[di + 3] = 255;
      } else if (colorType === 0) {
        rgba[di] = recon[si];
        rgba[di + 1] = recon[si];
        rgba[di + 2] = recon[si];
        rgba[di + 3] = 255;
      } else if (colorType === 4) {
        rgba[di] = recon[si];
        rgba[di + 1] = recon[si];
        rgba[di + 2] = recon[si];
        rgba[di + 3] = recon[si + 1];
      } else {
        // 调色板：不常见，跳过（返回空）
        throw new Error('palette not supported');
      }
    }
    prev = recon;
  }
  return { width, height, rgba };
}

/** 把 RGBA 像素编码为 PNG Buffer（8bit RGBA, filter 0） */
export function encodePng(width: number, height: number, rgba: Buffer): Buffer {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter None
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  // 使用 level 1 换取更快的编码速度（缩略图/标注图不需要极高压缩率）
  const idat = zlib.deflateSync(raw, { level: 1 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * 高效 RGB PNG 编码器（对齐 ok-script compress_coco 的压缩效果）。
 *
 * 与 encodePng 的区别：
 * - RGB (colorType=2) 而非 RGBA：省 33% 数据
 * - Sub filter (filter=1)：提高压缩率 10-30%
 * - zlib level 6：平衡压缩率与速度
 */
export function encodePngRgb(width: number, height: number, rgba: Buffer): Buffer {
  const stride = width * 3; // RGB, 3 bytes per pixel
  const raw = Buffer.alloc((stride + 1) * height);

  for (let y = 0; y < height; y++) {
    const rawRowStart = y * (stride + 1);
    raw[rawRowStart] = 1; // filter: Sub (value = current - left)

    const rgbaRowStart = y * width * 4;
    const rowStart = rawRowStart + 1;

    // 第一个像素：filter=Sub 时 left=0，所以 raw = pixel
    raw[rowStart] = rgba[rgbaRowStart];       // R
    raw[rowStart + 1] = rgba[rgbaRowStart + 1]; // G
    raw[rowStart + 2] = rgba[rgbaRowStart + 2]; // B

    // 后续像素：raw = pixel - left
    for (let x = 1; x < width; x++) {
      const di = rowStart + x * 3;
      const si = rgbaRowStart + x * 4;
      const pi = rgbaRowStart + (x - 1) * 4;
      raw[di] = (rgba[si] - rgba[pi]) & 0xff;         // R
      raw[di + 1] = (rgba[si + 1] - rgba[pi + 1]) & 0xff; // G
      raw[di + 2] = (rgba[si + 2] - rgba[pi + 2]) & 0xff; // B
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB (colorType=2)
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const idat = zlib.deflateSync(raw, { level: 6 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 从 RGBA 像素按 bbox 裁剪并编码为 PNG data URL（统一高度等比缩放） */
function cropAndEncode(
  width: number,
  height: number,
  rgba: Buffer,
  bbox: [number, number, number, number],
  targetHeight: number,
): string {
  const [bx, by, bw, bh] = bbox;
  const cx = Math.max(0, Math.min(bx, width));
  const cy = Math.max(0, Math.min(by, height));
  const cw = Math.max(1, Math.min(bw, width - cx));
  const ch = Math.max(1, Math.min(bh, height - cy));

  // 裁剪
  const cropped = Buffer.alloc(cw * ch * 4);
  for (let y = 0; y < ch; y++) {
    const srcStart = ((cy + y) * width + cx) * 4;
    rgba.copy(cropped, y * cw * 4, srcStart, srcStart + cw * 4);
  }

  // 统一高度等比缩放（不足 targetHeight 也放大到统一高度）
  const scale = targetHeight / ch;
  const outW = Math.max(1, Math.round(cw * scale));
  const outH = Math.max(1, Math.round(ch * scale));
  const pixels = Buffer.alloc(outW * outH * 4);
  for (let y = 0; y < outH; y++) {
    const sy = Math.min(ch - 1, Math.floor(y / scale));
    for (let x = 0; x < outW; x++) {
      const sx = Math.min(cw - 1, Math.floor(x / scale));
      cropped.copy(pixels, (y * outW + x) * 4, (sy * cw + sx) * 4, (sy * cw + sx) * 4 + 4);
    }
  }

  const png = encodePng(outW, outH, pixels);
  return `data:image/png;base64,${png.toString('base64')}`;
}

/** 从原图按 bbox 裁剪并编码为 PNG data URL；失败返回 undefined */
export function cropTemplateToDataUrl(
  imagePath: string,
  bbox: [number, number, number, number],
  targetHeight = 100,
): string | undefined {
  try {
    const buf = fs.readFileSync(imagePath);
    const { width, height, rgba } = decodeRgba(buf);
    return cropAndEncode(width, height, rgba, bbox, targetHeight);
  } catch {
    return undefined;
  }
}

const CROP_CACHE = new Map<string, string>();
const CROP_CACHE_MAX = 600;

function cropKey(
  imagePath: string,
  bbox: [number, number, number, number],
  targetHeight: number,
): string {
  return `${imagePath}|${bbox.join(',')}|${targetHeight}`;
}

/** 带缓存的裁剪：同图同 bbox 只解码一次（缓存 data URL）。 */
export function cropTemplateToDataUrlCached(
  imagePath: string,
  bbox: [number, number, number, number],
  targetHeight = 100,
): string | undefined {
  const key = cropKey(imagePath, bbox, targetHeight);
  const hit = CROP_CACHE.get(key);
  if (hit !== undefined) return hit;
  const url = cropTemplateToDataUrl(imagePath, bbox, targetHeight);
  if (url !== undefined) {
    if (CROP_CACHE.size >= CROP_CACHE_MAX) CROP_CACHE.clear();
    CROP_CACHE.set(key, url);
  }
  return url;
}

/** 预热裁剪请求 */
export interface CropRequest {
  imagePath: string;
  bbox: [number, number, number, number];
  targetHeight?: number;
}

/**
 * 后台预热：按原图分组解码（同一 4K 原图只解码一次），分片让出事件循环，
 * 把全部模板缩略图写进缓存，后续 hover/补全直接命中。只补缺失项。
 */
export async function warmCropCache(
  requests: CropRequest[],
  batchSize = 4,
): Promise<void> {
  const groups = new Map<string, CropRequest[]>();
  for (const r of requests) {
    const arr = groups.get(r.imagePath);
    if (arr) arr.push(r);
    else groups.set(r.imagePath, [r]);
  }

  const imagePaths = [...groups.keys()];
  for (let i = 0; i < imagePaths.length; i += batchSize) {
    // 让出事件循环，避免阻塞 UI
    await new Promise((resolve) => setImmediate(resolve));
    const chunk = imagePaths.slice(i, i + batchSize);
    for (const imagePath of chunk) {
      const items = groups.get(imagePath)!;
      const targetHeight = items[0]?.targetHeight ?? 100;
      // 该原图的所有模板都已缓存则整组跳过
      if (items.every((it) => CROP_CACHE.has(cropKey(it.imagePath, it.bbox, it.targetHeight ?? targetHeight)))) {
        continue;
      }
      try {
        const buf = fs.readFileSync(imagePath);
        const { width, height, rgba } = decodeRgba(buf);
        for (const it of items) {
          const th = it.targetHeight ?? targetHeight;
          const key = cropKey(it.imagePath, it.bbox, th);
          if (CROP_CACHE.has(key)) continue;
          if (CROP_CACHE.size >= CROP_CACHE_MAX) CROP_CACHE.clear();
          CROP_CACHE.set(key, cropAndEncode(width, height, rgba, it.bbox, th));
        }
      } catch {
        // 单张原图失败忽略，后续 hover 再按需处理
      }
    }
  }
}

/** 模板标注/图片变化时清空裁剪缓存。 */
export function clearCropCache(): void {
  CROP_CACHE.clear();
}

/* ---------------- 原始分辨率裁剪落盘（供 saveToAssets bin-packing 使用） ---------------- */

/**
 * 从原图按 bbox 裁剪（保持原始分辨率，不缩放），将裁剪区域写入指定路径的 PNG 文件。
 * 用于 saveToAssets 的 bin-packing 流程中单 bbox 直接裁剪场景。
 * @returns 输出文件绝对路径；失败返回 undefined。
 */
export function cropTemplateOriginalFile(
  imagePath: string,
  bbox: [number, number, number, number],
  outDir: string,
  fileName: string,
): string | undefined {
  try {
    const buf = fs.readFileSync(imagePath);
    const { width, height, rgba } = decodeRgba(buf);
    const [bx, by, bw, bh] = bbox;
    const cx = Math.max(0, Math.min(bx, width));
    const cy = Math.max(0, Math.min(by, height));
    const cw = Math.max(1, Math.min(bw, width - cx));
    const ch = Math.max(1, Math.min(bh, height - cy));

    // 裁剪（不缩放）
    const cropped = Buffer.alloc(cw * ch * 4);
    for (let y = 0; y < ch; y++) {
      const srcStart = ((cy + y) * width + cx) * 4;
      rgba.copy(cropped, y * cw * 4, srcStart, srcStart + cw * 4);
    }

    const png = encodePng(cw, ch, cropped);
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, fileName);
    fs.writeFileSync(outPath, png);
    return outPath;
  } catch {
    return undefined;
  }
}

/* ---------------- 缩略图落盘（供 webview 通过 asWebviewUri 加载） ---------------- */

/** 生成确定性文件名：同图同 bbox 同尺寸 → 同一文件，天然去重 */
function thumbFileName(imagePath: string, bbox: [number, number, number, number], targetHeight: number): string {
  const key = `${imagePath}|${bbox.join(',')}|${targetHeight}`;
  const hash = crypto.createHash('sha1').update(key).digest('hex').slice(0, 16);
  return `t_${hash}.png`;
}

/** 返回模板缩略图的确定性绝对路径，不创建文件。 */
export function templateThumbFilePath(
  imagePath: string,
  bbox: [number, number, number, number],
  outDir: string,
  targetHeight = 96,
): string {
  return path.join(outDir, thumbFileName(imagePath, bbox, targetHeight));
}

/**
 * 把模板缩略图写成 PNG 文件（复用 data URL 裁剪缓存），返回文件绝对路径。
 * webview 中用 asWebviewUri 加载本地文件比 data: URL 更可靠。
 */
export function cropTemplateThumbFile(
  imagePath: string,
  bbox: [number, number, number, number],
  outDir: string,
  targetHeight = 96,
): string | undefined {
  const file = templateThumbFilePath(imagePath, bbox, outDir, targetHeight);
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > 0) return file;
  } catch {
    // 状态异常则重写
  }
  const url = cropTemplateToDataUrlCached(imagePath, bbox, targetHeight);
  if (!url) return undefined;
  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(file, Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'));
    return file;
  } catch {
    return undefined;
  }
}

/** 删除一个确定性模板缩略图；用于共享缓存中的定向失效。 */
export function removeTemplateThumbFile(
  imagePath: string,
  bbox: [number, number, number, number],
  outDir: string,
  targetHeight = 96,
): void {
  try {
    fs.rmSync(templateThumbFilePath(imagePath, bbox, outDir, targetHeight), { force: true });
  } catch {
    // 缩略图不存在或删除失败时忽略，后续仍可按需重建
  }
}

/** 清空缩略图目录内容（目录不存在则忽略；递归删除子目录）。 */
export function clearThumbDir(outDir: string): void {
  try {
    if (!fs.existsSync(outDir)) return;
    for (const f of fs.readdirSync(outDir)) {
      try {
        fs.rmSync(path.join(outDir, f), { recursive: true, force: true });
      } catch {
        // 单个删除失败忽略
      }
    }
  } catch {
    // 忽略
  }
}

/* ---------------- 原图查看（ok_templates 原图 + bbox 红框标注） ---------------- */

/**
 * 把 assets/images/N.png 映射到真正的原始截图 ok_templates/N.png。
 * 兼容 ok_tasks/assets/images → ok_tasks/ok_templates 与仓库根 ok_templates；
 * 找不到映射时回退原路径。
 */
export function resolveOriginalImagePath(imagePath: string): string {
  const m = imagePath.match(/^(.*[/\\])assets[/\\]images([/\\][^/\\]+)$/);
  if (!m) return imagePath;
  const candidates: string[] = [];
  const rest = m[2];
  let prefix = m[1];
  candidates.push(path.join(prefix, 'ok_templates', rest));
  // ok_tasks/assets/images → 仓库根的 ok_templates
  const stripped = prefix.replace(/ok_tasks[/\\]$/, '');
  if (stripped !== prefix) candidates.push(path.join(stripped, 'ok_templates', rest));
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      // 忽略
    }
  }
  return imagePath;
}

/** 在 RGBA 像素上沿矩形边缘向内画描边 */
function strokeRectInward(
  rgba: Buffer,
  imgW: number,
  imgH: number,
  x: number,
  y: number,
  w: number,
  h: number,
  thickness: number,
  r: number,
  g: number,
  b: number,
): void {
  const x0 = Math.max(0, x);
  const y0 = Math.max(0, y);
  const x1 = Math.min(imgW - 1, x + w - 1);
  const y1 = Math.min(imgH - 1, y + h - 1);
  if (x1 < x0 || y1 < y0) return;
  for (let py = y0; py <= y1; py++) {
    for (let px = x0; px <= x1; px++) {
      if (px < x0 + thickness || px > x1 - thickness || py < y0 + thickness || py > y1 - thickness) {
        const i = (py * imgW + px) * 4;
        rgba[i] = r;
        rgba[i + 1] = g;
        rgba[i + 2] = b;
        rgba[i + 3] = 255;
      }
    }
  }
}

/** 在 bbox 处画标注框：红色主框（覆盖 bbox 边缘）+ 外圈白色光晕，任何底色下都可见 */
function drawRectOutline(
  rgba: Buffer,
  imgW: number,
  imgH: number,
  x: number,
  y: number,
  w: number,
  h: number,
  thickness: number,
): void {
  const halo = Math.max(2, thickness >> 1);
  // 先画白色：矩形向外扩 halo，描边宽度 thickness+halo，随后红色覆盖其内侧 thickness，
  // 最终效果 = bbox 边缘内 thickness 红色 + 向外 halo 白色
  strokeRectInward(rgba, imgW, imgH, x - halo, y - halo, w + 2 * halo, h + 2 * halo, thickness + halo, 255, 255, 255);
  strokeRectInward(rgba, imgW, imgH, x, y, w, h, thickness, 255, 40, 40);
}

/**
 * 解码原图、在 bbox 处画红框标注并写出 PNG。
 * 优化：只裁剪 bbox 周围区域（含 200px 边距）并编码，而非全图，大幅提速。
 * 返回输出文件路径；失败返回 undefined。
 */
export function writeAnnotatedImage(
  imagePath: string,
  bbox: [number, number, number, number],
  outPath: string,
): string | undefined {
  try {
    const buf = fs.readFileSync(imagePath);
    const { width, height, rgba } = decodeRgba(buf);
    const [bx, by, bw, bh] = [
      Math.max(0, Math.min(bbox[0], width - 1)),
      Math.max(0, Math.min(bbox[1], height - 1)),
      Math.max(1, Math.min(bbox[2], width - Math.max(0, bbox[0]))),
      Math.max(1, Math.min(bbox[3], height - Math.max(0, bbox[1]))),
    ];
    // 围绕 bbox 裁剪区域，含 200px 边距（不超出图片边界）
    const pad = 200;
    const cropX = Math.max(0, bx - pad);
    const cropY = Math.max(0, by - pad);
    const cropW = Math.min(width - cropX, bw + 2 * pad + Math.min(pad, bx));
    const cropH = Math.min(height - cropY, bh + 2 * pad + Math.min(pad, by));

    // 裁剪像素区域
    const cropRgba = Buffer.alloc(cropW * cropH * 4);
    for (let y = 0; y < cropH; y++) {
      const srcStart = ((cropY + y) * width + cropX) * 4;
      rgba.copy(cropRgba, y * cropW * 4, srcStart, srcStart + cropW * 4);
    }

    // 在裁剪区域中画标注框（坐标需要相对偏移）
    const relX = bx - cropX;
    const relY = by - cropY;
    const thickness = Math.max(3, Math.min(10, Math.round(Math.min(width, height) * 0.004)));
    drawRectOutline(cropRgba, cropW, cropH, relX, relY, bw, bh, thickness);

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    // 用低压缩级别换取生成速度（标注图不需要极高压缩率）
    fs.writeFileSync(outPath, encodePng(cropW, cropH, cropRgba));
    return outPath;
  } catch {
    return undefined;
  }
}

/**
 * 生成（带缓存）"原始截图 + bbox 红框标注" 的 PNG，返回文件路径。
 * 原图来源按优先级：
 *   1. ok_templates 反查（labelme json 按模板名+坐标匹配，最准确）
 *   2. coco 引用的 assets/images 副本兜底（可能非原始分辨率，但内容正确）
 * 同一来源同一 bbox 只生成一次。
 * 注：已移除 resolveOriginalImagePath 的简单编号映射，因 assets/images 与
 * ok_templates 的编号不对应，会导致找到错误的图片。
 */
export function openAnnotatedImage(
  imagePath: string,
  name: string,
  bbox: [number, number, number, number],
  thumbDir: string,
  rootDir: string,
): string | undefined {
  const candidates: string[] = [];
  const viaLabelme = findOkTemplateOriginal(rootDir, name, bbox);
  if (viaLabelme) candidates.push(viaLabelme);
  if (!candidates.includes(imagePath)) candidates.push(imagePath);

  for (const src of candidates) {
    try {
      if (!fs.existsSync(src)) continue;
    } catch {
      continue;
    }
    const key = crypto.createHash('sha1').update(`${src}|${bbox.join(',')}`).digest('hex').slice(0, 16);
    const out = path.join(thumbDir, 'annotated', `a_${key}.png`);
    try {
      if (fs.existsSync(out) && fs.statSync(out).size > 0) return out;
    } catch {
      // 状态异常则重新生成
    }
    const written = writeAnnotatedImage(src, bbox, out);
    if (written) return written;
  }
  return undefined;
}
