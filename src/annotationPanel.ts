import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { TemplateAssetData } from './templateAssetData';
import { tr, webviewStrings } from './localization';

/* ---------------- 标注数据类型 ---------------- */

interface Annotation {
  id: number;
  category: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/* ---------------- 控制器 ---------------- */

class AnnotationController {
  private generation = 0;
  private disposed = false;
  private readonly disposables: vscode.Disposable[] = [];
  private _currentImage: string | undefined;
  private _imageList: string[] = [];

  constructor(
    private readonly webview: vscode.Webview,
    private readonly data: TemplateAssetData,
    private readonly thumbDir: string,
    private readonly isVisible: () => boolean,
    private readonly onSaved: (imagePath: string) => void,
  ) {
    this.disposables.push(
      webview.onDidReceiveMessage((msg) => { void this.onMessage(msg); }),
    );
  }

  get currentImage(): string | undefined { return this._currentImage; }

  attachHtml(): void {
    this.webview.html = annotationHtml(this.webview.cspSource);
  }

  open(imagePath: string, imageList: string[]): void {
    this._imageList = [...imageList];
    this._currentImage = imagePath;
    this.loadImage(imagePath);
  }

  private async loadImage(imagePath: string): Promise<void> {
    if (this.disposed) return;
    this._currentImage = imagePath;

    // 读取图片为 base64
    let imageBase64 = '';
    try {
      const buf = fs.readFileSync(imagePath);
      imageBase64 = `data:image/png;base64,${buf.toString('base64')}`;
    } catch {
      imageBase64 = '';
    }

    // 读取标注数据
    const annotations = this.data.getAnnotationsForImage(imagePath);

    // 获取所有分类名（用于验证唯一性）
    const allCategories: Record<string, string> = {};
    for (const img of this.data.data.images) {
      const imgPath = path.join(this.data.templatesDir, img.file_name);
      if (imgPath === imagePath) continue;
      const cats = this.data.getCategoriesForImage(imgPath);
      for (const c of cats) {
        allCategories[c] = img.file_name;
      }
    }

    const currentIndex = this._imageList.indexOf(imagePath);

    await this.webview.postMessage({
      type: 'load',
      imagePath,
      imageBase64,
      annotations: annotations.map((a) => ({
        id: a.id,
        category: a.categoryName,
        x: a.bbox[0],
        y: a.bbox[1],
        w: a.bbox[2],
        h: a.bbox[3],
      })),
      allCategories,
      currentIndex,
      totalImages: this._imageList.length,
      filename: path.basename(imagePath),
    });
  }

  private async onMessage(msg: {
    type?: string;
    annotation?: Annotation;
    annotations?: Annotation[];
    index?: number;
    category?: string;
    x?: number;
    y?: number;
    w?: number;
    h?: number;
  }): Promise<void> {
    switch (msg.type) {
      case 'ready':
        if (this._currentImage) {
          await this.loadImage(this._currentImage);
        }
        break;
      case 'save': {
        if (!this._currentImage || !msg.annotations) break;
        this.data.setAnnotationsForImage(
          this._currentImage,
          msg.annotations.map((a) => ({ category: a.category, x: a.x, y: a.y, w: a.w, h: a.h })),
        );
        this.data.save();
        this.onSaved(this._currentImage);
        break;
      }
      case 'navigate': {
        if (msg.index === undefined || msg.index < 0 || msg.index >= this._imageList.length) break;
        await this.loadImage(this._imageList[msg.index]);
        break;
      }
      case 'deleteAnnotation': {
        if (!this._currentImage || !msg.annotation) break;
        const annotations = this.data.getAnnotationsForImage(this._currentImage);
        const annId = (msg.annotation as unknown as { id: number }).id;
        const filtered = annotations.filter((a) => a.id !== annId);
        this.data.setAnnotationsForImage(
          this._currentImage,
          filtered.map((a) => ({ category: a.categoryName, x: a.bbox[0], y: a.bbox[1], w: a.bbox[2], h: a.bbox[3] })),
        );
        this.data.save();
        this.onSaved(this._currentImage);
        // 重新加载
        await this.loadImage(this._currentImage);
        break;
      }
      case 'copyColor': {
        if (typeof msg.category === 'string') {
          await vscode.env.clipboard.writeText(msg.category);
          void vscode.window.showInformationMessage(tr('Copied: {text}', { text: msg.category }));
        }
        break;
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.generation++;
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }
}

/* ---------------- 面板 ---------------- */

export class AnnotationPanel {
  static current: AnnotationPanel | undefined;

  static show(
    data: TemplateAssetData,
    thumbDir: string,
    imagePath: string,
    imageList: string[],
    onSaved: (imagePath: string) => void,
  ): void {
    if (AnnotationPanel.current) {
      AnnotationPanel.current.panel.reveal();
      AnnotationPanel.current.controller.open(imagePath, imageList);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'okLangHintsAnnotation',
      tr('Annotation Editor'),
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.file(thumbDir),
          vscode.Uri.file(data.templatesDir),
        ],
      },
    );
    const controller = new AnnotationController(
      panel.webview,
      data,
      thumbDir,
      () => panel.visible,
      onSaved,
    );
    AnnotationPanel.current = new AnnotationPanel(panel, controller);
    controller.open(imagePath, imageList);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    readonly controller: AnnotationController,
  ) {
    controller.attachHtml();
    panel.onDidDispose(() => {
      controller.dispose();
      AnnotationPanel.current = undefined;
    });
  }
}

/* ---------------- Nonce 生成 ---------------- */

function getNonce(): string {
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';
  for (let i = 0; i < 32; i++) value += possible.charAt(Math.floor(Math.random() * possible.length));
  return value;
}

/* ---------------- HTML ---------------- */

function annotationHtml(cspSource: string): string {
  const nonce = getNonce();
  const strings = JSON.stringify(webviewStrings()).replace(/</g, '\\u003c');
  const csp = [
    "default-src 'none'",
    `img-src data: ${cspSource} vscode-resource:`,
    `script-src ${cspSource} 'nonce-${nonce}'`,
    "style-src 'unsafe-inline'",
  ].join('; ');
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    color: var(--vscode-editor-foreground);
    background: var(--vscode-editor-background);
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size, 13px);
    overflow: hidden;
    height: 100vh;
    display: flex;
    flex-direction: column;
  }
  .toolbar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    border-bottom: 1px solid var(--vscode-panel-border);
    flex-shrink: 0;
    flex-wrap: wrap;
  }
  .toolbar button {
    padding: 4px 10px;
    border-radius: 3px;
    border: 1px solid var(--vscode-button-secondaryBackground, rgba(128,128,128,.3));
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    cursor: pointer;
    font-size: 12px;
    white-space: nowrap;
  }
  .toolbar button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .toolbar button.active {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border-color: var(--vscode-button-background);
  }
  .toolbar .spacer { flex: 1; }
  .toolbar .info { font-size: 11px; opacity: .7; white-space: nowrap; }
  .canvas-wrap {
    flex: 1;
    position: relative;
    overflow: hidden;
  }
  canvas {
    display: block;
    width: 100%;
    height: 100%;
    cursor: crosshair;
  }
  .color-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    border-top: 1px solid var(--vscode-panel-border);
    font-size: 11px;
    flex-shrink: 0;
  }
  .color-swatch {
    width: 14px; height: 14px;
    border: 1px solid gray;
    border-radius: 2px;
    flex-shrink: 0;
  }
  .modal-overlay {
    display: none;
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,.45);
    z-index: 100;
    align-items: center;
    justify-content: center;
  }
  .modal-overlay.visible { display: flex; }
  .modal {
    background: var(--vscode-editorWidget-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 8px;
    padding: 18px 22px;
    min-width: 340px;
    box-shadow: 0 8px 32px rgba(0,0,0,.4);
  }
  .modal h3 { margin-bottom: 12px; font-size: 14px; }
  .modal .row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .modal label { width: 70px; text-align: right; font-size: 12px; opacity: .8; }
  .modal input[type="text"],
  .modal input[type="number"] {
    flex: 1;
    padding: 4px 8px;
    border-radius: 3px;
    border: 1px solid var(--vscode-input-border, transparent);
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    font-size: 13px;
    outline: none;
  }
  .modal input:focus { border-color: var(--vscode-focusBorder); }
  .modal .error { color: var(--vscode-errorForeground); font-size: 11px; margin-top: 4px; }
  .modal .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
  .modal .actions button {
    padding: 5px 16px;
    border-radius: 3px;
    border: 1px solid var(--vscode-button-secondaryBackground, rgba(128,128,128,.3));
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    cursor: pointer;
    font-size: 12px;
  }
  .modal .actions button.primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border-color: var(--vscode-button-background);
  }
  .empty {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    opacity: .5;
  }
</style>
</head>
<body>
  <div class="toolbar">
    <button id="drawBtn">Draw (R)</button>
    <button id="deleteBtn">Delete (D)</button>
    <div class="spacer"></div>
    <span class="info" id="navInfo"></span>
    <button id="prevBtn" title="Previous image">◀</button>
    <button id="nextBtn" title="Next image">▶</button>
  </div>
  <div class="canvas-wrap">
    <canvas id="canvas"></canvas>
    <div class="empty" id="emptyMsg"></div>
  </div>
  <div class="color-bar">
    <div class="color-swatch" id="swatch"></div>
    <span id="colorInfo"></span>
  </div>

  <!-- BBox 输入对话框 -->
  <div class="modal-overlay" id="bboxModal">
    <div class="modal">
      <h3 id="bboxTitle">Bounding Box</h3>
      <div class="row">
        <label id="bboxCatLabel">Category:</label>
        <input type="text" id="bboxCat" placeholder="Category name" />
      </div>
      <div class="error" id="bboxError"></div>
      <div class="row"><label>X:</label><input type="number" id="bboxX" min="0" /></div>
      <div class="row"><label>Y:</label><input type="number" id="bboxY" min="0" /></div>
      <div class="row"><label id="bboxWLabel">Width:</label><input type="number" id="bboxW" min="1" /></div>
      <div class="row"><label id="bboxHLabel">Height:</label><input type="number" id="bboxH" min="1" /></div>
      <div class="actions">
        <button id="bboxCancel">Cancel</button>
        <button id="bboxOk" class="primary">OK</button>
      </div>
    </div>
  </div>

<script nonce="${nonce}">
(function() {
  const I18N = ${strings};
  const t = (key, args = {}) => (I18N[key] || key).replace(/\\{(\\w+)\\}/g, (_, name) => String(args[name] ?? '{' + name + '}'));
  const vscode = acquireVsCodeApi();
  const canvas = document.getElementById('canvas');
  const ctx = canvas.getContext('2d');
  const emptyMsg = document.getElementById('emptyMsg');

  // Localize UI elements
  document.getElementById('bboxCatLabel').textContent = t('categoryLabel');
  document.getElementById('bboxCat').placeholder = t('categoryLabel');
  document.getElementById('bboxWLabel').textContent = t('widthLabel');
  document.getElementById('bboxHLabel').textContent = t('heightLabel');
  document.getElementById('bboxCancel').textContent = t('cancel');
  document.getElementById('bboxTitle').textContent = t('newBboxTitle');
  document.getElementById('drawBtn').textContent = t('drawBbox');
  document.getElementById('drawBtn').title = t('drawBboxTooltip');
  document.getElementById('deleteBtn').textContent = t('deleteMode');
  document.getElementById('deleteBtn').title = t('deleteBboxTooltip');
  document.getElementById('prevBtn').title = t('prevImage');
  document.getElementById('nextBtn').title = t('nextImage');
  document.getElementById('emptyMsg').textContent = t('noImageLoaded');

  // 状态
  let imageData = null;   // { imagePath, imageBase64, annotations, allCategories, filename }
  let img = null;         // HTMLImageElement
  let scale = 1.0;
  let fitScale = 1.0;
  let offsetX = 0, offsetY = 0;

  // 标注
  let annotations = [];
  let nextId = 1;
  let selectedIdx = -1;
  let hoveredIdx = -1;

  // 模式: none, draw, delete
  let mode = 'none';
  let drawStart = null;   // widget coords
  let drawPreview = null;  // widget coords

  // 拖拽
  let dragging = false;
  let dragStartPos = null;
  let dragOrigRect = null;

  // 缩放调整
  let resizing = false;
  let resizeHandle = null;
  let resizeStartPos = null;
  let resizeOrigRect = null;

  // 平移
  let panning = false;
  let panStartPos = null;
  let panStartOffset = null;

  // 缩放
  const EDGE_MARGIN = 8;

  // 颜色信息
  let currentColorText = '';

  /* ---------- 坐标转换 ---------- */
  function imgToWidget(ix, iy) {
    return [ix * scale + offsetX, iy * scale + offsetY];
  }
  function widgetToImg(wx, wy) {
    return [(wx - offsetX) / scale, (wy - offsetY) / scale];
  }
  function annWidgetRect(ann) {
    const [wx, wy] = imgToWidget(ann.x, ann.y);
    return { x: wx, y: wy, w: ann.w * scale, h: ann.h * scale };
  }
  function rectContains(r, px, py) {
    return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
  }

  /* ---------- 缩放控制检测 ---------- */
  function detectHandle(px, py, r) {
    const m = EDGE_MARGIN;
    const nearL = Math.abs(px - r.x) <= m && py >= r.y - m && py <= r.y + r.h + m;
    const nearR = Math.abs(px - (r.x + r.w)) <= m && py >= r.y - m && py <= r.y + r.h + m;
    const nearT = Math.abs(py - r.y) <= m && px >= r.x - m && px <= r.x + r.w + m;
    const nearB = Math.abs(py - (r.y + r.h)) <= m && px >= r.x - m && px <= r.x + r.w + m;
    if (nearT && nearL) return 'tl';
    if (nearT && nearR) return 'tr';
    if (nearB && nearL) return 'bl';
    if (nearB && nearR) return 'br';
    if (nearT) return 'top';
    if (nearB) return 'bottom';
    if (nearL) return 'left';
    if (nearR) return 'right';
    return null;
  }
  function handleCursor(h) {
    if (h === 'tl' || h === 'br') return 'nwse-resize';
    if (h === 'tr' || h === 'bl') return 'nesw-resize';
    if (h === 'top' || h === 'bottom') return 'ns-resize';
    if (h === 'left' || h === 'right') return 'ew-resize';
    return 'default';
  }

  /* ---------- 查找标注 ---------- */
  function findAnnAt(px, py) {
    for (let i = annotations.length - 1; i >= 0; i--) {
      const r = annWidgetRect(annotations[i]);
      if (rectContains(r, px, py)) return i;
    }
    return -1;
  }
  function findHandleAt(px, py) {
    for (let i = annotations.length - 1; i >= 0; i--) {
      const r = annWidgetRect(annotations[i]);
      const h = detectHandle(px, py, r);
      if (h) return { idx: i, handle: h };
    }
    return { idx: -1, handle: null };
  }

  /* ---------- 绘制 ---------- */
  function paint() {
    if (!canvas.width || !canvas.height) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const dark = getComputedStyle(document.body).getPropertyValue('color').includes('255') ||
                 document.body.classList.contains('vscode-dark');
    ctx.fillStyle = dark ? '#1e1e1e' : '#f5f5f5';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (img) {
      ctx.drawImage(img, offsetX, offsetY, img.width * scale, img.height * scale);
    }

    // 画标注
    annotations.forEach((ann, i) => {
      const isSel = i === selectedIdx;
      const isHov = i === hoveredIdx;
      const r = annWidgetRect(ann);

      let strokeColor = isSel ? '#0078d4' : isHov ? '#ffa500' : '#ff3c3c';
      let fillColor = isSel ? 'rgba(0,120,212,0.15)' : isHov ? 'rgba(255,165,0,0.12)' : 'rgba(255,60,60,0.08)';

      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = isSel ? 2.5 : 2;
      ctx.fillStyle = fillColor;
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.strokeRect(r.x, r.y, r.w, r.h);

      // 高亮控制点
      if (isHov) {
        ctx.fillStyle = '#00c800';
        const corners = { tl: [r.x, r.y], tr: [r.x + r.w, r.y], bl: [r.x, r.y + r.h], br: [r.x + r.w, r.y + r.h] };
        for (const [k, v] of Object.entries(corners)) {
          ctx.beginPath();
          ctx.arc(v[0], v[1], 4, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // 标签
      ctx.fillStyle = strokeColor;
      ctx.font = 'bold 11px sans-serif';
      ctx.fillText(ann.category, r.x + 2, r.y - 4);
    });

    // 画预览
    if (mode === 'draw' && drawStart && drawPreview) {
      const [ix1, iy1] = widgetToImg(drawStart.x, drawStart.y);
      const [ix2, iy2] = widgetToImg(drawPreview.x, drawPreview.y);
      const px = Math.min(ix1, ix2), py = Math.min(iy1, iy2);
      const pw = Math.abs(ix2 - ix1), ph = Math.abs(iy2 - iy1);
      const [wx, wy] = imgToWidget(px, py);
      ctx.strokeStyle = '#00c800';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 3]);
      ctx.fillStyle = 'rgba(0,200,0,0.1)';
      ctx.fillRect(wx, wy, pw * scale, ph * scale);
      ctx.strokeRect(wx, wy, pw * scale, ph * scale);
      ctx.setLineDash([]);
    }
  }

  /* ---------- 缩放/适配 ---------- */
  function recalcFit() {
    if (!img) { fitScale = 1; return; }
    fitScale = Math.min(canvas.width / img.width, canvas.height / img.height);
  }
  function recalcOffset() {
    if (!img) { offsetX = 0; offsetY = 0; return; }
    const sw = img.width * scale, sh = img.height * scale;
    if (sw <= canvas.width) offsetX = (canvas.width - sw) / 2;
    else offsetX = Math.min(0, Math.max(canvas.width - sw, offsetX));
    if (sh <= canvas.height) offsetY = (canvas.height - sh) / 2;
    else offsetY = Math.min(0, Math.max(canvas.height - sh, offsetY));
  }
  function isZoomed() {
    return img && (img.width * scale > canvas.width || img.height * scale > canvas.height);
  }

  /* ---------- resize ---------- */
  function resize() {
    const wrap = canvas.parentElement;
    canvas.width = wrap.clientWidth;
    canvas.height = wrap.clientHeight;
    if (img) { recalcFit(); if (scale < fitScale) scale = fitScale; recalcOffset(); }
    paint();
  }

  /* ---------- 鼠标事件 ---------- */
  canvas.addEventListener('mousedown', (e) => {
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;

    if (e.button === 2) { // 右键
      const idx = findAnnAt(px, py);
      if (idx >= 0) {
        selectedIdx = idx;
        vscode.postMessage({ type: 'copyColor', category: annotations[idx].category });
        paint();
      }
      return;
    }
    if (e.button !== 0) return;

    if (mode === 'draw') {
      if (!drawStart) {
        drawStart = { x: px, y: py };
      } else {
        finishDraw(px, py);
      }
      return;
    }
    if (mode === 'delete') {
      const idx = findAnnAt(px, py);
      if (idx >= 0) { selectedIdx = idx; deleteSelected(); }
      return;
    }

    // 普通模式：先检测缩放控制点
    const { idx: hIdx, handle } = findHandleAt(px, py);
    if (handle && hIdx >= 0) {
      selectedIdx = hIdx;
      resizing = true;
      resizeHandle = handle;
      resizeStartPos = { x: px, y: py };
      const ann = annotations[hIdx];
      resizeOrigRect = { x: ann.x, y: ann.y, w: ann.w, h: ann.h };
      paint();
      return;
    }

    // 检测选择/拖拽
    const idx = findAnnAt(px, py);
    selectedIdx = idx;
    if (idx >= 0) {
      dragging = true;
      dragStartPos = { x: px, y: py };
      const ann = annotations[idx];
      dragOrigRect = { x: ann.x, y: ann.y, w: ann.w, h: ann.h };
    } else if (isZoomed()) {
      panning = true;
      panStartPos = { x: px, y: py };
      panStartOffset = { x: offsetX, y: offsetY };
      canvas.style.cursor = 'grabbing';
    }
    paint();
  });

  canvas.addEventListener('dblclick', (e) => {
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    const idx = findAnnAt(px, py);
    if (idx >= 0) {
      selectedIdx = idx;
      // 恢复拖拽原始位置
      if (dragging && dragOrigRect) {
        annotations[idx].x = dragOrigRect.x;
        annotations[idx].y = dragOrigRect.y;
      }
      dragging = false; dragStartPos = null; dragOrigRect = null;
      resizing = false; resizeStartPos = null; resizeOrigRect = null; resizeHandle = null;
      paint();
      showEditDialog(idx);
    }
  });

  canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;

    if (mode === 'draw' && drawStart) {
      drawPreview = { x: px, y: py };
      paint();
      return;
    }
    if (resizing && selectedIdx >= 0 && resizeStartPos) {
      doResize(px, py);
      paint();
      return;
    }
    if (dragging && selectedIdx >= 0 && dragStartPos) {
      const dxW = px - dragStartPos.x, dyW = px - dragStartPos.y;
      const dxI = dxW / scale, dyI = (py - dragStartPos.y) / scale;
      const ann = annotations[selectedIdx];
      let nx = dragOrigRect.x + dxI, ny = dragOrigRect.y + dyI;
      if (img) {
        nx = Math.max(0, Math.min(nx, img.width - ann.w));
        ny = Math.max(0, Math.min(ny, img.height - ann.h));
      }
      ann.x = Math.round(nx);
      ann.y = Math.round(ny);
      paint();
      return;
    }
    if (panning && panStartPos) {
      offsetX = panStartOffset.x + (px - panStartPos.x);
      offsetY = panStartOffset.y + (py - panStartPos.y);
      recalcOffset();
      paint();
      return;
    }

    // Hover 检测
    if (mode === 'none') {
      const { idx: hIdx, handle } = findHandleAt(px, py);
      if (handle && hIdx >= 0) {
        hoveredIdx = hIdx;
        canvas.style.cursor = handleCursor(handle);
      } else {
        const aIdx = findAnnAt(px, py);
        hoveredIdx = aIdx;
        if (aIdx >= 0) canvas.style.cursor = 'move';
        else if (isZoomed()) canvas.style.cursor = 'grab';
        else canvas.style.cursor = 'crosshair';
      }
      paint();
    } else if (mode === 'draw') {
      canvas.style.cursor = 'crosshair';
    } else if (mode === 'delete') {
      const aIdx = findAnnAt(px, py);
      hoveredIdx = aIdx;
      canvas.style.cursor = aIdx >= 0 ? 'pointer' : 'default';
      paint();
    }

    // 更新颜色信息
    updateColorAt(px, py);
  });

  canvas.addEventListener('mouseup', () => {
    if (dragging) { dragging = false; dragStartPos = null; dragOrigRect = null; saveAnnotations(); }
    if (resizing) { resizing = false; resizeStartPos = null; resizeOrigRect = null; resizeHandle = null; saveAnnotations(); }
    if (panning) {
      panning = false; panStartPos = null; panStartOffset = null;
      canvas.style.cursor = isZoomed() ? 'grab' : 'crosshair';
    }
  });

  canvas.addEventListener('wheel', (e) => {
    if (!img) return;
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    const [ix, iy] = widgetToImg(px, py);
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    let ns = scale * factor;
    ns = Math.max(fitScale, Math.min(50, ns));
    scale = ns;
    offsetX = px - ix * scale;
    offsetY = py - iy * scale;
    recalcOffset();
    e.preventDefault();
    paint();
  }, { passive: false });

  /* ---------- resize 逻辑 ---------- */
  function doResize(px, py) {
    const ann = annotations[selectedIdx];
    const orig = resizeOrigRect;
    const dxI = (px - resizeStartPos.x) / scale;
    const dyI = (py - resizeStartPos.y) / scale;
    let nx = orig.x, ny = orig.y, nw = orig.w, nh = orig.h;
    const h = resizeHandle;
    if (h === 'left' || h === 'tl' || h === 'bl') { nx = orig.x + dxI; nw = orig.w - dxI; }
    if (h === 'right' || h === 'tr' || h === 'br') { nw = orig.w + dxI; }
    if (h === 'top' || h === 'tl' || h === 'tr') { ny = orig.y + dyI; nh = orig.h - dyI; }
    if (h === 'bottom' || h === 'bl' || h === 'br') { nh = orig.h + dyI; }
    const minS = 5;
    if (nw < minS) { if (h.includes('left')) nx = orig.x + orig.w - minS; nw = minS; }
    if (nh < minS) { if (h.includes('top')) ny = orig.y + orig.h - minS; nh = minS; }
    if (img) {
      nx = Math.max(0, nx); ny = Math.max(0, ny);
      if (nx + nw > img.width) nw = img.width - nx;
      if (ny + nh > img.height) nh = img.height - ny;
    }
    ann.x = Math.round(nx); ann.y = Math.round(ny);
    ann.w = Math.round(nw); ann.h = Math.round(nh);
  }

  /* ---------- 画框完成 ---------- */
  function finishDraw(px, py) {
    const [ix1, iy1] = widgetToImg(drawStart.x, drawStart.y);
    const [ix2, iy2] = widgetToImg(px, py);
    const x = Math.round(Math.min(ix1, ix2)), y = Math.round(Math.min(iy1, iy2));
    const w = Math.round(Math.abs(ix2 - ix1)), h = Math.round(Math.abs(iy2 - iy1));
    drawStart = null; drawPreview = null;
    if (w < 3 || h < 3) { paint(); return; }
    showBBoxDialog('', x, y, w, h, (cat, bx, by, bw, bh) => {
      if (cat) {
        annotations.push({ id: nextId++, category: cat, x: bx, y: by, w: bw, h: bh });
        saveAnnotations();
        paint();
      }
      setMode('none');
    });
  }

  /* ---------- 删除 ---------- */
  function deleteSelected() {
    if (selectedIdx < 0) return;
    annotations.splice(selectedIdx, 1);
    selectedIdx = -1;
    hoveredIdx = -1;
    saveAnnotations();
    paint();
  }

  /* ---------- 保存标注 ---------- */
  function saveAnnotations() {
    vscode.postMessage({ type: 'save', annotations });
  }

  /* ---------- 模式切换 ---------- */
  function setMode(m) {
    mode = m;
    drawStart = null; drawPreview = null;
    document.getElementById('drawBtn').classList.toggle('active', m === 'draw');
    document.getElementById('deleteBtn').classList.toggle('active', m === 'delete');
    if (m === 'draw') canvas.style.cursor = 'crosshair';
    else if (m === 'delete') canvas.style.cursor = 'default';
    else canvas.style.cursor = isZoomed() ? 'grab' : 'crosshair';
    paint();
  }

  /* ---------- BBox 对话框 ---------- */
  function showBBoxDialog(category, x, y, w, h, callback) {
    const modal = document.getElementById('bboxModal');
    const catInput = document.getElementById('bboxCat');
    const errorEl = document.getElementById('bboxError');
    const xInput = document.getElementById('bboxX');
    const yInput = document.getElementById('bboxY');
    const wInput = document.getElementById('bboxW');
    const hInput = document.getElementById('bboxH');
    document.getElementById('bboxTitle').textContent = category ? t('editBboxTitle') : t('newBboxTitle');
    catInput.value = category;
    xInput.value = x; yInput.value = y; wInput.value = w; hInput.value = h;
    errorEl.textContent = '';
    modal.classList.add('visible');
    catInput.focus();

    function validate() {
      const name = catInput.value.trim();
      if (!name) { errorEl.textContent = t('categoryRequired'); return false; }
      const existing = imageData?.allCategories || {};
      if (name !== category && existing[name]) {
        errorEl.textContent = "Already exists in '" + existing[name] + "'";
        return false;
      }
      errorEl.textContent = '';
      return true;
    }
    catInput.oninput = validate;

    document.getElementById('bboxOk').onclick = () => {
      if (!validate()) return;
      modal.classList.remove('visible');
      callback(catInput.value.trim(), +xInput.value, +yInput.value, +wInput.value, +hInput.value);
    };
    document.getElementById('bboxCancel').onclick = () => {
      modal.classList.remove('visible');
      callback(null);
    };
  }

  function showEditDialog(idx) {
    const ann = annotations[idx];
    showBBoxDialog(ann.category, ann.x, ann.y, ann.w, ann.h, (cat, x, y, w, h) => {
      if (cat) {
        ann.category = cat; ann.x = x; ann.y = y; ann.w = w; ann.h = h;
        saveAnnotations(); paint();
      }
    });
  }

  /* ---------- 颜色信息 ---------- */
  function updateColorAt(px, py) {
    if (!img) return;
    const [ix, iy] = widgetToImg(px, py);
    const iix = Math.round(ix), iiy = Math.round(iy);
    const info = document.getElementById('colorInfo');
    const swatch = document.getElementById('swatch');
    if (iix < 0 || iiy < 0 || iix >= img.width || iiy >= img.height || !imgData) {
      info.textContent = 'Abs: (' + iix + ', ' + iiy + ')';
      swatch.style.background = 'transparent';
      return;
    }
    const idx = (iiy * img.width + iix) * 4;
    const r = imgData.data[idx], g = imgData.data[idx + 1], b = imgData.data[idx + 2];
    const relX = (ix / img.width).toFixed(3), relY = (iy / img.height).toFixed(3);
    info.textContent = 'R:' + r + ' G:' + g + ' B:' + b + '  Abs:(' + iix + ',' + iiy + ') Rel:(' + relX + ',' + relY + ')';
    swatch.style.background = 'rgb(' + r + ',' + g + ',' + b + ')';
  }

  let imgData = null;
  function loadImgData() {
    if (!img || !img.complete) { imgData = null; return; }
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const cx = c.getContext('2d');
    cx.drawImage(img, 0, 0);
    imgData = cx.getImageData(0, 0, img.width, img.height);
  }

  /* ---------- 键盘事件 ---------- */
  document.addEventListener('keydown', (e) => {
    if (document.getElementById('bboxModal').classList.contains('visible')) return;
    if (e.key === 'r' || e.key === 'R') {
      setMode(mode === 'draw' ? 'none' : 'draw');
    } else if (e.key === 'd' || e.key === 'D') {
      setMode(mode === 'delete' ? 'none' : 'delete');
    } else if (e.key === 'Delete' && selectedIdx >= 0 && mode === 'none') {
      deleteSelected();
    } else if (e.key === 'ArrowLeft') {
      navigate(-1);
    } else if (e.key === 'ArrowRight') {
      navigate(1);
    }
  });

  /* ---------- 导航 ---------- */
  function navigate(delta) {
    if (!imageData) return;
    const newIdx = imageData.currentIndex + delta;
    if (newIdx < 0 || newIdx >= imageData.totalImages) return;
    setMode('none');
    selectedIdx = -1; hoveredIdx = -1;
    vscode.postMessage({ type: 'navigate', index: newIdx });
  }

  /* ---------- 按钮事件 ---------- */
  document.getElementById('drawBtn').onclick = () => setMode(mode === 'draw' ? 'none' : 'draw');
  document.getElementById('deleteBtn').onclick = () => setMode(mode === 'delete' ? 'none' : 'delete');
  document.getElementById('prevBtn').onclick = () => navigate(-1);
  document.getElementById('nextBtn').onclick = () => navigate(1);

  /* ---------- 接收消息 ---------- */
  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg.type === 'load') {
      imageData = msg;
      annotations = msg.annotations || [];
      nextId = annotations.length ? Math.max(...annotations.map(a => a.id)) + 1 : 1;
      selectedIdx = -1; hoveredIdx = -1;

      if (msg.imageBase64) {
        img = new Image();
        img.onload = () => {
          emptyMsg.style.display = 'none';
          canvas.style.display = 'block';
          recalcFit(); scale = fitScale; recalcOffset();
          loadImgData();
          paint();
        };
        img.src = msg.imageBase64;
      } else {
        img = null; imgData = null;
        canvas.style.display = 'none';
        emptyMsg.style.display = 'flex';
      }

      // 更新导航
      document.getElementById('navInfo').textContent =
        msg.filename + ' (' + (msg.currentIndex + 1) + '/' + msg.totalImages + ')';
      document.getElementById('prevBtn').disabled = msg.currentIndex <= 0;
      document.getElementById('nextBtn').disabled = msg.currentIndex >= msg.totalImages - 1;
    }
  });

  /* ---------- 初始化 ---------- */
  window.addEventListener('resize', resize);
  resize();
  vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
}
