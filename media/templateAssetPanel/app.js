  const I18N = JSON.parse(document.getElementById('assetPanelI18n')?.textContent || '{}');
  const t = (key, args = {}) => (I18N[key] || key).replace(/\{(\w+)\}/g, (_, name) => String(args[name] ?? '{' + name + '}'));
  const vscode = acquireVsCodeApi();
  const grid = document.getElementById('grid');
  const search = document.getElementById('search');
  const countEl = document.getElementById('count');
  const emptyEl = document.getElementById('empty');
  const cards = new Map();
  let metas = [];

  document.title = t('templateAssetsTitle');
  search.placeholder = t('templatesSearch');
  document.getElementById('importBtn').textContent = t('assetImport');
  document.getElementById('screenshotBtn').textContent = t('screenshot');
  document.getElementById('saveBtn').textContent = t('saveToAssetsTitle');

  function updateCount() {
    const shown = shownCount();
    countEl.textContent = shown + '/' + metas.length;
  }
  function shownCount() {
    let n = 0;
    for (const card of cards.values()) if (card.style.display !== 'none') n++;
    return n;
  }

  function makeCard(meta) {
    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.name = meta.name;
    card.title = meta.name + '\n' + meta.width + 'x' + meta.height +
      (meta.categories.length ? '\n' + meta.categories.join(', ') : '');

    const box = document.createElement('div');
    box.className = 'thumb-box';
    const ph = document.createElement('span');
    ph.className = 'placeholder';
    ph.textContent = '...';
    box.appendChild(ph);

    const actDiv = document.createElement('div');
    actDiv.className = 'actions';
    const delBtn = document.createElement('button');
    delBtn.textContent = 'X';
    delBtn.title = t('assetDeleteTooltip');
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: 'deleteImage', imagePath: meta.imagePath });
    });
    actDiv.appendChild(delBtn);
    box.appendChild(actDiv);

    const m = document.createElement('div');
    m.className = 'meta';
    const nm = document.createElement('div');
    nm.className = 'name';
    nm.textContent = meta.name;
    const cats = document.createElement('div');
    cats.className = 'cats';
    cats.textContent = meta.categories.length ? meta.categories.join(', ') : '';
    const sz = document.createElement('div');
    sz.className = 'size';
    sz.textContent = meta.width + 'x' + meta.height;
    m.appendChild(nm);
    m.appendChild(cats);
    m.appendChild(sz);

    card.appendChild(box);
    card.appendChild(m);
    card.addEventListener('click', () => {
      vscode.postMessage({ type: 'openAnnotation', imagePath: meta.imagePath });
    });
    return card;
  }

  function applyFilter() {
    const q = search.value.trim().toLowerCase();
    let shown = 0;
    for (const [name, card] of cards) {
      const meta = metas.find(m => m.name === name);
      const ok = !q || name.toLowerCase().includes(q) ||
        (meta && meta.categories.some(c => c.toLowerCase().includes(q)));
      card.style.display = ok ? '' : 'none';
      if (ok) shown++;
    }
    updateCount();
    emptyEl.style.display = 'none';
    if (metas.length === 0) {
      emptyEl.style.display = '';
      emptyEl.textContent = t('noTemplatesWithHint');
    } else if (shown === 0) {
      emptyEl.style.display = '';
      emptyEl.textContent = t('assetNoMatch') + ': "' + search.value.trim() + '"';
    }
  }

  search.addEventListener('input', () => applyFilter());

  function attachThumb(name, url) {
    const card = cards.get(name);
    if (!card || card.dataset.thumbDone === '1') return;
    card.dataset.thumbDone = '1';
    const img = document.createElement('img');
    img.src = url; img.alt = name;
    img.style.display = 'none';
    img.addEventListener('load', () => {
      const ph = card.querySelector('.placeholder');
      if (ph) ph.remove();
      img.style.display = 'block';
    });
    img.addEventListener('error', () => {
      const ph = card.querySelector('.placeholder');
      if (ph) { ph.textContent = t('loadFailed'); ph.style.opacity = '.8'; }
    });
    card.querySelector('.thumb-box').prepend(img);
  }

  document.getElementById('importBtn').addEventListener('click', () => {
    vscode.postMessage({ type: 'importFile' });
  });
  document.getElementById('screenshotBtn').addEventListener('click', () => {
    vscode.postMessage({ type: 'screenshot' });
  });
  document.getElementById('saveBtn').addEventListener('click', () => {
    vscode.postMessage({ type: 'saveToAssets' });
  });

  window.addEventListener('message', (e) => {
    const msg = e.data;
    switch (msg.type) {
      case 'templates': {
        grid.innerHTML = ''; cards.clear();
        metas = msg.templates || [];
        for (const meta of metas) {
          const card = makeCard(meta);
          cards.set(meta.name, card);
          grid.appendChild(card);
        }
        applyFilter();
        break;
      }
      case 'thumbs': {
        for (const it of (msg.items || [])) attachThumb(it.name, it.url);
        break;
      }
    }
  });

  vscode.postMessage({ type: 'ready' });
