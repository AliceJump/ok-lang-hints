import * as fs from 'fs';
import * as zlib from 'zlib';

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
function decodeRgba(buf: Buffer): { width: number; height: number; rgba: Buffer } {
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
function encodePng(width: number, height: number, rgba: Buffer): Buffer {
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
