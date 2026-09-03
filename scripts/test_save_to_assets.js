/**
 * 测试 saveToAssets() 的 bin-packing 逻辑
 *
 * 验证：
 * 1. 多个不重叠 bbox 能打包到同一张原尺寸 PNG
 * 2. 不同图片的重叠 bbox 会分到不同 PNG
 * 3. COCO bbox 坐标保持不变
 * 4. 无标注图片直接复制
 * 5. read_from_json 可按原 bbox 正确裁剪模板
 * 6. 不同尺寸图片不会混合打包
 *
 * 运行方式：node scripts/test_save_to_assets.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

/* ---------- mock vscode 模块（TemplateAssetData 需要） ---------- */

const vscodeMockPath = path.join(__dirname, '..', 'node_modules', 'vscode');
const vscodeAlreadyExists = fs.existsSync(vscodeMockPath);
if (!vscodeAlreadyExists) {
  fs.mkdirSync(vscodeMockPath, { recursive: true });
  fs.writeFileSync(
    path.join(vscodeMockPath, 'index.js'),
    `module.exports = { workspace: { workspaceFolders: undefined } };`
  );
}

let TemplateAssetData;
try {
  TemplateAssetData = require('../out/templateAssetData').TemplateAssetData;
} finally {
  if (!vscodeAlreadyExists) {
    fs.rmSync(vscodeMockPath, { recursive: true, force: true });
  }
}

/* ---------- 辅助：断言 ---------- */

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/* ---------- 辅助：生成纯色 PNG ---------- */

function createPng(width, height, r, g, b) {
  const zlib = require('zlib');

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 2; // color type: RGB
  ihdrData[10] = 0;
  ihdrData[11] = 0;
  ihdrData[12] = 0;

  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: None
    for (let x = 0; x < width; x++) {
      const offset = y * (stride + 1) + 1 + x * 3;
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
    }
  }

  const idatData = zlib.deflateSync(raw);

  function crc32(buf) {
    let c = 0xffffffff;
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let cc = n;
      for (let k = 0; k < 8; k++) cc = cc & 1 ? 0xedb88320 ^ (cc >>> 1) : cc >>> 1;
      table[n] = cc >>> 0;
    }
    for (let i = 0; i < buf.length; i++) {
      c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  function makeChunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([len, body, crc]);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    makeChunk('IHDR', ihdrData),
    makeChunk('IDAT', idatData),
    makeChunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------- 辅助：创建临时目录 ---------- */

let tmpDir;
let templateDir;
let targetDir;

function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ok-save-test-'));
  templateDir = path.join(tmpDir, 'ok_templates');
  targetDir = path.join(tmpDir, 'assets');
  fs.mkdirSync(templateDir, { recursive: true });
  fs.mkdirSync(targetDir, { recursive: true });
}

function teardown() {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
}

/* ========== 测试 1：不重叠 bbox 打包到同一张 PNG ========== */

function test_nonOverlappingBboxesPackToSamePage() {
  setup();
  try {
    fs.writeFileSync(path.join(templateDir, '1.png'), createPng(100, 100, 128, 128, 128));

    const cocoData = {
      images: [{ id: 1, file_name: '1.png', width: 100, height: 100 }],
      annotations: [
        { id: 1, image_id: 1, category_id: 1, bbox: [10, 10, 20, 20], area: 400, iscrowd: 0 },
        { id: 2, image_id: 1, category_id: 2, bbox: [50, 50, 30, 30], area: 900, iscrowd: 0 },
      ],
      categories: [
        { id: 1, name: 'boss_a', supercategory: '' },
        { id: 2, name: 'boss_b', supercategory: '' },
      ],
    };
    fs.writeFileSync(path.join(templateDir, 'coco_annotations.json'), JSON.stringify(cocoData));

    const data = new TemplateAssetData(tmpDir);
    data.load();
    data.saveToAssets(targetDir);

    const outCoco = JSON.parse(fs.readFileSync(path.join(targetDir, 'coco_annotations.json'), 'utf-8'));

    assert(outCoco.images.length === 1,
      `expected 1 packed image, got ${outCoco.images.length}`);

    const packedImg = outCoco.images[0];
    assert(packedImg.width === 100 && packedImg.height === 100,
      `packed image should be 100x100, got ${packedImg.width}x${packedImg.height}`);

    const annA = outCoco.annotations.find((a) => a.category_id === 1);
    const annB = outCoco.annotations.find((a) => a.category_id === 2);
    assert(annA && annB, 'annotations not found');
    assert(annA.bbox[0] === 10 && annA.bbox[1] === 10 && annA.bbox[2] === 20 && annA.bbox[3] === 20,
      `annA bbox should be [10,10,20,20], got [${annA.bbox}]`);
    assert(annB.bbox[0] === 50 && annB.bbox[1] === 50 && annB.bbox[2] === 30 && annB.bbox[3] === 30,
      `annB bbox should be [50,50,30,30], got [${annB.bbox}]`);
    assert(annA.image_id === annB.image_id,
      'both annotations should point to same packed image');

    const packedPath = path.join(targetDir, 'images', packedImg.file_name);
    assert(fs.existsSync(packedPath), 'packed PNG file should exist');
    const packedBuf = fs.readFileSync(packedPath);
    assert(packedBuf.readUInt32BE(16) === 100 && packedBuf.readUInt32BE(20) === 100,
      'packed PNG dimensions should be 100x100');

    console.log('[PASS] test_nonOverlappingBboxesPackToSamePage');
  } finally {
    teardown();
  }
}

/* ========== 测试 2：不同图片的重叠 bbox 分到不同 PNG ========== */

function test_overlappingBboxesSplitToDifferentPages() {
  setup();
  try {
    // 两张不同源图（同尺寸 100x100），bbox 区域重叠
    fs.writeFileSync(path.join(templateDir, '1.png'), createPng(100, 100, 128, 128, 128));
    fs.writeFileSync(path.join(templateDir, '2.png'), createPng(100, 100, 100, 200, 50));

    const cocoData = {
      images: [
        { id: 1, file_name: '1.png', width: 100, height: 100 },
        { id: 2, file_name: '2.png', width: 100, height: 100 },
      ],
      annotations: [
        { id: 1, image_id: 1, category_id: 1, bbox: [10, 10, 40, 40], area: 1600, iscrowd: 0 },
        { id: 2, image_id: 2, category_id: 2, bbox: [30, 30, 40, 40], area: 1600, iscrowd: 0 },
      ],
      categories: [
        { id: 1, name: 'boss_a', supercategory: '' },
        { id: 2, name: 'boss_b', supercategory: '' },
      ],
    };
    fs.writeFileSync(path.join(templateDir, 'coco_annotations.json'), JSON.stringify(cocoData));

    const data = new TemplateAssetData(tmpDir);
    data.load();
    data.saveToAssets(targetDir);

    const outCoco = JSON.parse(fs.readFileSync(path.join(targetDir, 'coco_annotations.json'), 'utf-8'));

    assert(outCoco.images.length === 2,
      `expected 2 packed images for overlapping cross-image bboxes, got ${outCoco.images.length}`);

    for (const img of outCoco.images) {
      assert(img.width === 100 && img.height === 100,
        `packed image should be 100x100, got ${img.width}x${img.height}`);
    }

    const annA = outCoco.annotations.find((a) => a.category_id === 1);
    const annB = outCoco.annotations.find((a) => a.category_id === 2);
    assert(annA && annB && annA.image_id !== annB.image_id,
      'overlapping cross-image annotations should have different image_ids');
    assert(annA.bbox[0] === 10 && annA.bbox[1] === 10 && annA.bbox[2] === 40 && annA.bbox[3] === 40,
      `annA bbox should be [10,10,40,40], got [${annA.bbox}]`);
    assert(annB.bbox[0] === 30 && annB.bbox[1] === 30 && annB.bbox[2] === 40 && annB.bbox[3] === 40,
      `annB bbox should be [30,30,40,40], got [${annB.bbox}]`);

    console.log('[PASS] test_overlappingBboxesSplitToDifferentPages');
  } finally {
    teardown();
  }
}

/* ========== 测试 3：COCO bbox 坐标保持不变 ========== */

function test_bboxCoordinatesUnchanged() {
  setup();
  try {
    fs.writeFileSync(path.join(templateDir, '1.png'), createPng(200, 150, 100, 200, 50));

    const originalBboxes = [
      [5, 8, 33, 42],
      [100, 50, 60, 70],
      [150, 100, 45, 48],
    ];

    const cocoData = {
      images: [{ id: 1, file_name: '1.png', width: 200, height: 150 }],
      annotations: originalBboxes.map((bbox, i) => ({
        id: i + 1, image_id: 1, category_id: i + 1,
        bbox, area: bbox[2] * bbox[3], iscrowd: 0,
      })),
      categories: originalBboxes.map((_, i) => ({
        id: i + 1, name: `template_${i + 1}`, supercategory: '',
      })),
    };
    fs.writeFileSync(path.join(templateDir, 'coco_annotations.json'), JSON.stringify(cocoData));

    const data = new TemplateAssetData(tmpDir);
    data.load();
    data.saveToAssets(targetDir);

    const outCoco = JSON.parse(fs.readFileSync(path.join(targetDir, 'coco_annotations.json'), 'utf-8'));

    for (let i = 0; i < originalBboxes.length; i++) {
      const orig = originalBboxes[i];
      const outAnn = outCoco.annotations.find((a) => a.category_id === i + 1);
      assert(outAnn, `annotation for category ${i + 1} not found`);
      assert(
        outAnn.bbox[0] === orig[0] && outAnn.bbox[1] === orig[1] &&
        outAnn.bbox[2] === orig[2] && outAnn.bbox[3] === orig[3],
        `bbox mismatch for category ${i + 1}: expected [${orig}], got [${outAnn.bbox}]`
      );
      assert(outAnn.area === orig[2] * orig[3],
        `area mismatch for category ${i + 1}: expected ${orig[2] * orig[3]}, got ${outAnn.area}`);
    }

    console.log('[PASS] test_bboxCoordinatesUnchanged');
  } finally {
    teardown();
  }
}

/* ========== 测试 4：无标注图片不放入 assets ========== */

function test_unannotatedImageExcluded() {
  setup();
  try {
    // 使用非数字名避免与 bin-pack 输出的 1.png 冲突
    fs.writeFileSync(path.join(templateDir, 'unannotated.png'), createPng(50, 50, 200, 100, 50));
    fs.writeFileSync(path.join(templateDir, '2.png'), createPng(80, 80, 50, 100, 200));

    const cocoData = {
      images: [
        { id: 1, file_name: 'unannotated.png', width: 50, height: 50 },
        { id: 2, file_name: '2.png', width: 80, height: 80 },
      ],
      annotations: [
        { id: 1, image_id: 2, category_id: 1, bbox: [10, 10, 30, 30], area: 900, iscrowd: 0 },
      ],
      categories: [{ id: 1, name: 'template_a', supercategory: '' }],
    };
    fs.writeFileSync(path.join(templateDir, 'coco_annotations.json'), JSON.stringify(cocoData));

    const data = new TemplateAssetData(tmpDir);
    data.load();
    data.saveToAssets(targetDir);

    // 无标注的 unannotated.png 不应被复制
    assert(!fs.existsSync(path.join(targetDir, 'images', 'unannotated.png')),
      'unannotated image should NOT be copied to assets');

    const outCoco = JSON.parse(fs.readFileSync(path.join(targetDir, 'coco_annotations.json'), 'utf-8'));

    // COCO images 中不应包含无标注图片
    const entry = outCoco.images.find((img) => img.file_name === 'unannotated.png');
    assert(!entry, 'unannotated image should NOT appear in COCO images');

    // 有标注的图片应被处理
    assert(outCoco.images.length >= 1, 'should have at least 1 packed image for annotated source');
    assert(outCoco.annotations.length === 1, 'should have 1 annotation');

    console.log('[PASS] test_unannotatedImageExcluded');
  } finally {
    teardown();
  }
}

/* ========== 测试 5：read_from_json 兼容性验证 ========== */

function test_readFromJsonCompatibility() {
  setup();
  try {
    fs.writeFileSync(path.join(templateDir, '1.png'), createPng(100, 100, 128, 128, 128));

    const cocoData = {
      images: [{ id: 1, file_name: '1.png', width: 100, height: 100 }],
      annotations: [
        { id: 1, image_id: 1, category_id: 1, bbox: [10, 10, 20, 20], area: 400, iscrowd: 0 },
        { id: 2, image_id: 1, category_id: 2, bbox: [60, 60, 30, 30], area: 900, iscrowd: 0 },
      ],
      categories: [
        { id: 1, name: 'tmpl_a', supercategory: '' },
        { id: 2, name: 'tmpl_b', supercategory: '' },
      ],
    };
    fs.writeFileSync(path.join(templateDir, 'coco_annotations.json'), JSON.stringify(cocoData));

    const data = new TemplateAssetData(tmpDir);
    data.load();
    data.saveToAssets(targetDir);

    const outCoco = JSON.parse(fs.readFileSync(path.join(targetDir, 'coco_annotations.json'), 'utf-8'));

    const packedFileName = outCoco.images.find((img) =>
      outCoco.annotations.some((a) => a.image_id === img.id)
    )?.file_name;
    assert(packedFileName, 'should have a packed image with annotations');

    const packedPath = path.join(targetDir, 'images', packedFileName);
    assert(fs.existsSync(packedPath), 'packed image should exist');

    const { decodeRgba } = require('../out/pngCrop');
    const decoded = decodeRgba(fs.readFileSync(packedPath));
    assert(decoded.width === 100 && decoded.height === 100,
      `packed image should be 100x100, got ${decoded.width}x${decoded.height}`);

    for (const ann of outCoco.annotations) {
      const [x, y, w, h] = ann.bbox;
      const roi = Buffer.alloc(w * h * 4);
      for (let row = 0; row < h; row++) {
        const srcStart = ((y + row) * decoded.width + x) * 4;
        decoded.rgba.copy(roi, row * w * 4, srcStart, srcStart + w * 4);
      }
      assert(roi.length === w * h * 4,
        `ROI should be ${w * h * 4} bytes, got ${roi.length}`);
    }

    console.log('[PASS] test_readFromJsonCompatibility');
  } finally {
    teardown();
  }
}

/* ========== 测试 6：不同尺寸图片不应混合打包 ========== */

function test_differentSizeImagesNotMixed() {
  setup();
  try {
    fs.writeFileSync(path.join(templateDir, '1.png'), createPng(100, 100, 128, 128, 128));
    fs.writeFileSync(path.join(templateDir, '2.png'), createPng(200, 150, 100, 200, 50));

    const cocoData = {
      images: [
        { id: 1, file_name: '1.png', width: 100, height: 100 },
        { id: 2, file_name: '2.png', width: 200, height: 150 },
      ],
      annotations: [
        { id: 1, image_id: 1, category_id: 1, bbox: [10, 10, 20, 20], area: 400, iscrowd: 0 },
        { id: 2, image_id: 2, category_id: 2, bbox: [10, 10, 20, 20], area: 400, iscrowd: 0 },
      ],
      categories: [
        { id: 1, name: 'tmpl_a', supercategory: '' },
        { id: 2, name: 'tmpl_b', supercategory: '' },
      ],
    };
    fs.writeFileSync(path.join(templateDir, 'coco_annotations.json'), JSON.stringify(cocoData));

    const data = new TemplateAssetData(tmpDir);
    data.load();
    data.saveToAssets(targetDir);

    const outCoco = JSON.parse(fs.readFileSync(path.join(targetDir, 'coco_annotations.json'), 'utf-8'));

    assert(outCoco.images.length === 2,
      `different size images should produce 2 packed images, got ${outCoco.images.length}`);

    const sizes = outCoco.images.map((img) => `${img.width}x${img.height}`).sort();
    assert(sizes.includes('100x100') && sizes.includes('200x150'),
      `expected 100x100 and 200x150, got ${sizes.join(', ')}`);

    console.log('[PASS] test_differentSizeImagesNotMixed');
  } finally {
    teardown();
  }
}

/* ========== 测试 7：多张不同图片的不重叠 bbox 打包到同一 Canvas ========== */

function test_multipleImagesNonOverlappingPackedTogether() {
  setup();
  try {
    fs.writeFileSync(path.join(templateDir, '1.png'), createPng(100, 100, 200, 0, 0));
    fs.writeFileSync(path.join(templateDir, '2.png'), createPng(100, 100, 0, 200, 0));
    fs.writeFileSync(path.join(templateDir, '3.png'), createPng(100, 100, 0, 0, 200));

    const cocoData = {
      images: [
        { id: 1, file_name: '1.png', width: 100, height: 100 },
        { id: 2, file_name: '2.png', width: 100, height: 100 },
        { id: 3, file_name: '3.png', width: 100, height: 100 },
      ],
      annotations: [
        { id: 1, image_id: 1, category_id: 1, bbox: [0, 0, 30, 30], area: 900, iscrowd: 0 },
        { id: 2, image_id: 2, category_id: 2, bbox: [70, 70, 30, 30], area: 900, iscrowd: 0 },
        { id: 3, image_id: 3, category_id: 3, bbox: [70, 0, 30, 30], area: 900, iscrowd: 0 },
      ],
      categories: [
        { id: 1, name: 'tmpl_1', supercategory: '' },
        { id: 2, name: 'tmpl_2', supercategory: '' },
        { id: 3, name: 'tmpl_3', supercategory: '' },
      ],
    };
    fs.writeFileSync(path.join(templateDir, 'coco_annotations.json'), JSON.stringify(cocoData));

    const data = new TemplateAssetData(tmpDir);
    data.load();
    data.saveToAssets(targetDir);

    const outCoco = JSON.parse(fs.readFileSync(path.join(targetDir, 'coco_annotations.json'), 'utf-8'));

    assert(outCoco.images.length === 1,
      `3 non-overlapping bboxes should pack into 1 image, got ${outCoco.images.length}`);

    const imageIds = new Set(outCoco.annotations.map((a) => a.image_id));
    assert(imageIds.size === 1,
      `all annotations should point to same packed image, got ${imageIds.size} distinct`);

    for (const ann of outCoco.annotations) {
      assert(ann.bbox[2] === 30 && ann.bbox[3] === 30,
        `bbox size should be 30x30, got ${ann.bbox[2]}x${ann.bbox[3]}`);
    }

    console.log('[PASS] test_multipleImagesNonOverlappingPackedTogether');
  } finally {
    teardown();
  }
}

/* ========== 测试 8：同一图片的重叠 bbox 应在同一 Canvas ========== */

function test_sameImageOverlappingBboxesStayTogether() {
  setup();
  try {
    fs.writeFileSync(path.join(templateDir, '1.png'), createPng(100, 100, 128, 128, 128));

    const cocoData = {
      images: [{ id: 1, file_name: '1.png', width: 100, height: 100 }],
      annotations: [
        { id: 1, image_id: 1, category_id: 1, bbox: [10, 10, 40, 40], area: 1600, iscrowd: 0 },
        { id: 2, image_id: 1, category_id: 2, bbox: [30, 30, 40, 40], area: 1600, iscrowd: 0 },
      ],
      categories: [
        { id: 1, name: 'boss_a', supercategory: '' },
        { id: 2, name: 'boss_b', supercategory: '' },
      ],
    };
    fs.writeFileSync(path.join(templateDir, 'coco_annotations.json'), JSON.stringify(cocoData));

    const data = new TemplateAssetData(tmpDir);
    data.load();
    data.saveToAssets(targetDir);

    const outCoco = JSON.parse(fs.readFileSync(path.join(targetDir, 'coco_annotations.json'), 'utf-8'));

    assert(outCoco.images.length === 1,
      `same-image overlapping bboxes should stay on 1 page, got ${outCoco.images.length}`);

    const annA = outCoco.annotations.find((a) => a.category_id === 1);
    const annB = outCoco.annotations.find((a) => a.category_id === 2);
    assert(annA && annB && annA.image_id === annB.image_id,
      'both annotations should point to same packed image');

    console.log('[PASS] test_sameImageOverlappingBboxesStayTogether');
  } finally {
    teardown();
  }
}

/* ========== 运行所有测试 ========== */

const tests = [
  test_nonOverlappingBboxesPackToSamePage,
  test_overlappingBboxesSplitToDifferentPages,
  test_bboxCoordinatesUnchanged,
  test_unannotatedImageExcluded,
  test_readFromJsonCompatibility,
  test_differentSizeImagesNotMixed,
  test_multipleImagesNonOverlappingPackedTogether,
  test_sameImageOverlappingBboxesStayTogether,
];

let passed = 0;
let failed = 0;

for (const test of tests) {
  try {
    test();
    passed++;
  } catch (e) {
    console.error(`[FAIL] ${test.name}: ${e.message}`);
    failed++;
  }
}

console.log(`\n========== Results: ${passed} passed, ${failed} failed ==========`);
if (failed > 0) process.exit(1);
