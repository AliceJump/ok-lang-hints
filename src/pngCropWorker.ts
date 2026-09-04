/**
 * pngCropWorker.ts — 独立 worker 线程，用 sharp (libvips) 处理所有 CPU 密集的图像操作。
 *
 * 每条任务 = 一张原图 + N 个 bbox：
 *   { id, imagePath, bboxes: [{ bbox, targetHeight }], thumbDir }
 *
 * 同一原图只 decode 一次，逐 bbox crop+resize+encode，返回：
 *   { id, results: [{ bbox, dataUrl, filePath }], error? }
 *
 * sharp 比纯 JS zlib.inflateSync + 逐像素循环快 10~100 倍。
 */
import { parentPort } from 'worker_threads';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import sharp from 'sharp';

/* ==================== 缩略图文件名 ==================== */

function thumbFileName(imagePath: string, bbox: [number, number, number, number], targetHeight: number): string {
  const key = `${imagePath}|${bbox.join(',')}|${targetHeight}`;
  const hash = crypto.createHash('sha1').update(key).digest('hex').slice(0, 16);
  return `t_${hash}.png`;
}

/* ==================== 消息处理 ==================== */

interface CropTask {
  id: number;
  imagePath: string;
  bboxes: Array<{
    bbox: [number, number, number, number];
    targetHeight: number;
  }>;
  thumbDir: string;
}

parentPort?.on('message', async (task: CropTask) => {
  const taskT0 = performance.now();
  try {
    // 读取原图文件（fs 在 worker 中也是同步的，但文件读取通常 <5ms）
    const buf = fs.readFileSync(task.imagePath);
    const readMs = performance.now() - taskT0;

    // sharp 一次 decode，后续 crop 复用内部图像引用
    const image = sharp(buf, { failOn: 'none' });
    const metadata = await image.metadata();
    const imgW = metadata.width ?? 0;
    const imgH = metadata.height ?? 0;
    if (imgW === 0 || imgH === 0) {
      parentPort?.postMessage({ id: task.id, results: [], error: 'invalid image' });
      return;
    }
    console.warn(`[pngCrop-worker] read ${path.basename(task.imagePath)} ${imgW}×${imgH} ${buf.length}B, ${readMs.toFixed(0)}ms`);

    const results: Array<{
      bbox: [number, number, number, number];
      dataUrl: string;
      filePath: string;
    }> = [];

    for (const item of task.bboxes) {
      const [bx, by, bw, bh] = item.bbox;
      // clamp 到图片边界
      const left = Math.max(0, Math.min(bx, imgW));
      const top = Math.max(0, Math.min(by, imgH));
      const extractW = Math.max(1, Math.min(bw, imgW - left));
      const extractH = Math.max(1, Math.min(bh, imgH - top));

      // sharp.extract + resize（native libvips，极快）
      const resized = await sharp(buf, { failOn: 'none' })
        .extract({ left, top, width: extractW, height: extractH })
        .resize({ height: item.targetHeight, kernel: sharp.kernel.nearest })
        .png({ compressionLevel: 1 }) // level 1 换速度
        .toBuffer({ resolveWithObject: true });

      const dataUrl = `data:image/png;base64,${resized.data.toString('base64')}`;

      // 写入缩略图文件
      const fileName = thumbFileName(task.imagePath, item.bbox, item.targetHeight);
      const filePath = path.join(task.thumbDir, fileName);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, resized.data);

      results.push({ bbox: item.bbox, dataUrl, filePath });
    }

    console.warn(`[pngCrop-worker] done ${path.basename(task.imagePath)} ×${task.bboxes.length} crop(s) in ${(performance.now() - taskT0).toFixed(0)}ms`);
    parentPort?.postMessage({ id: task.id, results });
  } catch (err) {
    console.warn(`[pngCrop-worker] error ${path.basename(task.imagePath)}: ${err}`);
    parentPort?.postMessage({ id: task.id, results: [], error: String(err) });
  }
});
