(function() {
  const I18N = JSON.parse(document.getElementById('annotationPanelI18n')?.textContent || '{}');
  const t = (key, args = {}) => (I18N[key] || key).replace(/\{(\w+)\}/g, (_, name) => String(args[name] ?? '{' + name + '}'));
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
  let drawDragging = false; // true when mouse is held down in draw mode
  let clipboard = null;    // copied bbox for Ctrl+C/V

  // 撤销/重做
  let undoStack = [];
  let redoStack = [];
  const MAX_UNDO = 100;

  // 可配置快捷键 (从扩展设置读取)
  let keybindings = {
    drawBbox: 'r',
    deleteMode: 'd',
    undo: 'ctrl+z',
    redo: 'ctrl+y',
    copy: 'ctrl+c',
    paste: 'ctrl+v',
    deleteSelected: 'Delete',
    prevImage: 'ArrowLeft',
    nextImage: 'ArrowRight'
  };

  function parseKeybinding(kb) {
    const parts = kb.toLowerCase().split('+');
    const key = parts.pop();
    const needCtrl = parts.includes('ctrl');
    const needShift = parts.includes('shift');
    const needAlt = parts.includes('alt');
    const needMeta = parts.includes('meta') || parts.includes('cmd');
    return { key, needCtrl, needShift, needAlt, needMeta };
  }

  function matchKeybinding(e, bindingStr) {
    const kb = parseKeybinding(bindingStr);
    const keyMatch = e.key.toLowerCase() === kb.key || e.code.toLowerCase() === kb.key;
    return keyMatch &&
           !!(e.ctrlKey || e.metaKey) === kb.needCtrl &&
           !!e.shiftKey === kb.needShift &&
           !!e.altKey === kb.needAlt;
  }

  function pushUndo() {
    undoStack.push(JSON.parse(JSON.stringify(annotations)));
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    redoStack = [];
  }

  function undo() {
    if (!undoStack.length) return;
    redoStack.push(JSON.parse(JSON.stringify(annotations)));
    annotations = undoStack.pop();
    nextId = annotations.length ? Math.max(...annotations.map(a => a.id)) + 1 : 1;
    selectedIdx = -1; hoveredIdx = -1;
    saveAnnotations(); paint();
  }

  function redo() {
    if (!redoStack.length) return;
    undoStack.push(JSON.parse(JSON.stringify(annotations)));
    annotations = redoStack.pop();
    nextId = annotations.length ? Math.max(...annotations.map(a => a.id)) + 1 : 1;
    selectedIdx = -1; hoveredIdx = -1;
    saveAnnotations(); paint();
  }

  function updateUndoRedoButtons() {
    const undoBtn = document.getElementById('undoBtn');
    const redoBtn = document.getElementById('redoBtn');
    if (undoBtn) { undoBtn.disabled = !undoStack.length; undoBtn.title = 'Undo (' + keybindings.undo + ')'; }
    if (redoBtn) { redoBtn.disabled = !redoStack.length; redoBtn.title = 'Redo (' + keybindings.redo + ')'; }
  }

  function updateButtonTexts() {
    const kb = keybindings;
    const drawBtn = document.getElementById('drawBtn');
    const deleteBtn = document.getElementById('deleteBtn');
    if (drawBtn) { drawBtn.textContent = t('drawBbox'); drawBtn.title = t('drawBboxTooltip'); }
    if (deleteBtn) { deleteBtn.textContent = t('deleteMode'); deleteBtn.title = t('deleteBboxTooltip'); }
    updateUndoRedoButtons();
  }

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
        drawDragging = true;
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
      pushUndo();
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
      pushUndo();
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
      // 双击不产生位移，回退 mousedown 时的 pushUndo
      if (undoStack.length > 0) undoStack.pop();
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

  canvas.addEventListener('mouseup', (e) => {
    if (mode === 'draw' && drawDragging && drawStart) {
      const rect = canvas.getBoundingClientRect();
      const px = e.clientX - rect.left, py = e.clientY - rect.top;
      const dx = px - drawStart.x, dy = py - drawStart.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > 5) {
        // Dragged far enough: finish as drag-to-draw
        finishDraw(px, py);
      }
      // If barely moved, keep drawStart for click-two-points (second click)
      drawDragging = false;
      return;
    }
    drawDragging = false;
    if (dragging) {
      const moved = dragOrigRect &&
        (annotations[selectedIdx].x !== dragOrigRect.x ||
         annotations[selectedIdx].y !== dragOrigRect.y);
      dragging = false; dragStartPos = null; dragOrigRect = null;
      if (moved) {
        saveAnnotations();
        updateUndoRedoButtons();
      } else {
        // 无实际移动，回退 pushUndo
        undoStack.pop();
      }
    }
    if (resizing) {
      const changed = resizeOrigRect &&
        (annotations[selectedIdx].x !== resizeOrigRect.x ||
         annotations[selectedIdx].y !== resizeOrigRect.y ||
         annotations[selectedIdx].w !== resizeOrigRect.w ||
         annotations[selectedIdx].h !== resizeOrigRect.h);
      resizing = false; resizeStartPos = null; resizeOrigRect = null; resizeHandle = null;
      if (changed) {
        saveAnnotations();
        updateUndoRedoButtons();
      } else {
        undoStack.pop();
      }
    }
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
        pushUndo();
        annotations.push({ id: nextId++, category: cat, x: bx, y: by, w: bw, h: bh });
        saveAnnotations();
        paint();
        updateUndoRedoButtons();
      }
      setMode('none');
    });
  }

  /* ---------- 删除 ---------- */
  function deleteSelected() {
    if (selectedIdx < 0) return;
    pushUndo();
    annotations.splice(selectedIdx, 1);
    selectedIdx = -1;
    hoveredIdx = -1;
    saveAnnotations();
    paint();
    updateUndoRedoButtons();
  }

  /* ---------- 保存标注 ---------- */
  function saveAnnotations() {
    vscode.postMessage({ type: 'save', annotations });
  }

  /* ---------- 模式切换 ---------- */
  function setMode(m) {
    mode = m;
    drawStart = null; drawPreview = null; drawDragging = false;
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
        pushUndo();
        ann.category = cat; ann.x = x; ann.y = y; ann.w = w; ann.h = h;
        saveAnnotations(); paint();
        updateUndoRedoButtons();
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

    // 撤销
    if (matchKeybinding(e, keybindings.undo)) {
      e.preventDefault(); undo(); updateUndoRedoButtons(); return;
    }
    // 重做
    if (matchKeybinding(e, keybindings.redo)) {
      e.preventDefault(); redo(); updateUndoRedoButtons(); return;
    }
    // 复制
    if (matchKeybinding(e, keybindings.copy) && selectedIdx >= 0 && mode === 'none') {
      const ann = annotations[selectedIdx];
      clipboard = { category: ann.category, x: ann.x, y: ann.y, w: ann.w, h: ann.h };
      return;
    }
    // 粘贴
    if (matchKeybinding(e, keybindings.paste) && clipboard && mode === 'none') {
      const offset = 10;
      pushUndo();
      const newAnn = {
        id: nextId++,
        category: clipboard.category,
        x: clipboard.x + offset,
        y: clipboard.y + offset,
        w: clipboard.w,
        h: clipboard.h
      };
      if (img) {
        newAnn.x = Math.min(newAnn.x, img.width - newAnn.w);
        newAnn.y = Math.min(newAnn.y, img.height - newAnn.h);
        newAnn.x = Math.max(0, newAnn.x);
        newAnn.y = Math.max(0, newAnn.y);
      }
      annotations.push(newAnn);
      selectedIdx = annotations.length - 1;
      saveAnnotations(); paint();
      updateUndoRedoButtons();
      return;
    }
    // 画框模式
    if (matchKeybinding(e, keybindings.drawBbox) && !e.ctrlKey && !e.metaKey && !e.altKey) {
      setMode(mode === 'draw' ? 'none' : 'draw');
    } else if (matchKeybinding(e, keybindings.deleteMode) && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // 删除模式
      setMode(mode === 'delete' ? 'none' : 'delete');
    } else if (matchKeybinding(e, keybindings.deleteSelected) && selectedIdx >= 0 && mode === 'none') {
      // 删除选中
      deleteSelected();
    } else if (matchKeybinding(e, keybindings.prevImage)) {
      // 上一张
      navigate(-1);
    } else if (matchKeybinding(e, keybindings.nextImage)) {
      // 下一张
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
  document.getElementById('undoBtn').onclick = () => { undo(); updateUndoRedoButtons(); };
  document.getElementById('redoBtn').onclick = () => { redo(); updateUndoRedoButtons(); };
  document.getElementById('prevBtn').onclick = () => navigate(-1);
  document.getElementById('nextBtn').onclick = () => navigate(1);

  /* ---------- 接收消息 ---------- */
  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg.type === 'config') {
      // 接收快捷键配置
      if (msg.keybindings) {
        Object.assign(keybindings, msg.keybindings);
      }
      updateButtonTexts();
      return;
    }
    if (msg.type === 'load') {
      imageData = msg;
      annotations = msg.annotations || [];
      nextId = annotations.length ? Math.max(...annotations.map(a => a.id)) + 1 : 1;
      selectedIdx = -1; hoveredIdx = -1;
      undoStack = []; redoStack = [];

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
      updateUndoRedoButtons();
    }
  });

  /* ---------- 初始化 ---------- */
  window.addEventListener('resize', resize);
  resize();
  vscode.postMessage({ type: 'ready' });
})();
