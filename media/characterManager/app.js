const I18N = JSON.parse(document.getElementById('characterManagerI18n')?.textContent || '{}');
const t = (key, args = {}) => (I18N[key] || key).replace(/\{(\w+)\}/g, (_, name) => String(args[name] ?? `{${name}}`));
const vscode = acquireVsCodeApi();
const previousState = vscode.getState() || {};
let snapshot = null;
let avatars = {};
let activeTab = previousState.activeTab || 'characters';
let selectedCharacterId = previousState.selectedCharacterId || '';
let modalSubmit = null;

const $ = (id) => document.getElementById(id);
const text = (value) => value === undefined || value === null ? '' : String(value);
const normalized = (value) => text(value).toLowerCase();
const currentQuery = () => normalized($('globalSearch').value.trim());
const saveState = () => vscode.setState({ activeTab, selectedCharacterId });

function localizeStaticUi() {
  document.documentElement.lang = navigator.language || 'en';
  document.title = t('charactersTitle');
  document.querySelector('.title').textContent = t('charactersTitle');
  $('globalSearch').placeholder = t('searchCharacters');
  $('refresh').title = t('refresh');
  const tabs = { characters: 'charactersTab', effects: 'effectsTab', locales: 'localesTab', issues: 'issuesTab' };
  for (const node of document.querySelectorAll('.tab')) {
    const badge = node.querySelector('.badge');
    node.replaceChildren(document.createTextNode(t(tabs[node.dataset.tab])), badge);
  }
  $('starFilter').options[0].textContent = t('allStars');
  $('elementFilter').options[0].textContent = t('allElements');
  $('professionFilter').options[0].textContent = t('allProfessions');
  $('skillTypeFilter').options[0].textContent = t('allSkillTypes');
  $('enhancementOnly').nextElementSibling.textContent = t('enhancementOnly');
  $('issueOnly').nextElementSibling.textContent = t('issueOnly');
  document.querySelector('.list-head > span:last-child').textContent = t('skillsEnhancements');
  $('effectSearch').placeholder = t('searchEffects');
  $('effectCategory').options[0].textContent = t('allCategories');
  $('effectUsage').options[0].textContent = t('allEffects');
  $('effectUsage').options[1].textContent = t('usedOnly');
  $('effectUsage').options[2].textContent = t('unusedOnly');
  $('effectUsage').options[3].textContent = t('unknownOnly');
  $('addEffectCategory').textContent = `＋ ${t('addEffectCategory')}`;
  $('addEffect').textContent = `＋ ${t('addEffect')}`;
  document.querySelector('.locale-toolbar > span:first-child').textContent = t('localizationMatrix');
  document.querySelector('.locale-toolbar > span:last-child').textContent = t('localizationHint');
  $('issueSearch').placeholder = t('searchIssues');
  $('issueSeverity').options[0].textContent = t('allSeverities');
  $('issueSeverity').options[1].textContent = t('error');
  $('issueSeverity').options[2].textContent = t('warning');
  $('issueSeverity').options[3].textContent = t('info');
  $('loading').firstElementChild.textContent = t('readingCharacterData');
  $('modalClose').title = t('close');
  $('modalCancel').textContent = `× ${t('cancel')}`;
  $('modalSave').textContent = `✓ ${t('save')}`;
}

function clear(node) { node.replaceChildren(); }
function element(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = text(content);
  return node;
}
function button(label, className, handler, title) {
  const node = element('button', className, label);
  if (title) node.title = title;
  node.addEventListener('click', handler);
  return node;
}
function postOpen(kind, extra) { vscode.postMessage({ type: 'openSource', kind, ...(extra || {}) }); }
function postCopy(value) { vscode.postMessage({ type: 'copy', text: value }); }
function mutate(payload) { vscode.postMessage({ type: 'mutateCharacter', ...payload }); }
function mutateEffect(payload) { vscode.postMessage({ type: 'mutateEffect', ...payload }); }
function formField(label, input, wide) {
  const field = element('div', `form-field${wide ? ' wide' : ''}`);
  field.append(element('label', '', label), input);
  return field;
}
function inputControl(value, type = 'text') {
  const input = document.createElement('input');
  input.type = type;
  input.value = value === undefined || value === null ? '' : String(value);
  return input;
}
function textareaControl(value, className = '') {
  const input = document.createElement('textarea');
  input.className = className;
  input.value = value === undefined || value === null ? '' : String(value);
  return input;
}
function readonlyControl(value, multiline) {
  const node = element('div', `readonly-value${multiline ? ' multiline' : ''}`, text(value) || '—');
  node.setAttribute('role', 'textbox');
  node.setAttribute('aria-readonly', 'true');
  return node;
}
function selectControl(value, options) {
  const select = document.createElement('select');
  const all = [...new Set([value, ...options].filter(Boolean))];
  for (const option of all) select.appendChild(new Option(option, option));
  select.value = value || all[0] || '';
  return select;
}

function createEffectEditor(initialEffects, idsOnly) {
  const editor = element('div', 'effect-editor');
  const left = element('div');
  const select = document.createElement('select');
  select.className = 'effect-select';
  select.multiple = true;
  const initialMap = new Map();
  for (const effect of initialEffects || []) {
    const id = effect.effectId || effect.effect_id || (typeof effect === 'string' ? effect : '');
    if (id) initialMap.set(id, effect);
  }
  const effects = [...snapshot.effects];
  for (const id of initialMap.keys()) {
    if (!effects.some((effect) => effect.id === id)) effects.unshift({ id, displayName: id, category: '__undefined__', description: t('unknownCurrentEffect'), defined: false, usages: [] });
  }
  const categories = new Map();
  for (const effect of effects) {
    const category = effect.category === '__undefined__' ? t('undefinedEffect') : effect.category;
    const list = categories.get(category) || [];
    list.push(effect);
    categories.set(category, list);
  }
  for (const [category, items] of categories) {
    const group = document.createElement('optgroup');
    group.label = category;
    for (const effect of items) {
      const displayName = effect.displayName || effect.description || effect.id;
      const option = new Option(`${displayName}${displayName === effect.id ? '' : ` · ${effect.id}`} — ${effect.description}`, effect.id);
      option.selected = initialMap.has(effect.id);
      group.appendChild(option);
    }
    select.appendChild(group);
  }
  left.append(select, element('div', 'effect-editor-hint', t('effectMultiHint')));
  const params = element('div', 'effect-params');
  editor.append(left, params);
  const values = new Map();
  const normalizeInitial = (id) => {
    const raw = initialMap.get(id);
    if (typeof raw === 'string' || !raw) return { effect_id: id, value: 0, duration: '', target: 'enemy', count: 1 };
    return { effect_id: id, value: raw.value ?? 0, duration: raw.duration ?? '', target: raw.target || 'enemy', count: raw.count ?? 1 };
  };
  const renderParams = () => {
    const selected = [...select.selectedOptions].map((option) => option.value);
    clear(params);
    if (idsOnly) {
      params.appendChild(element('div', 'empty', selected.length ? t('selectedTriggerEffects', { count: selected.length }) : t('noTriggerEffects')));
      return;
    }
    if (!selected.length) {
      params.appendChild(element('div', 'empty', t('noSelectedEffects')));
      return;
    }
    for (const id of selected) {
      if (!values.has(id)) values.set(id, normalizeInitial(id));
      const value = values.get(id);
      const definition = snapshot.effects.find((effect) => effect.id === id);
      const displayName = definition?.displayName || definition?.description || id;
      const row = element('div', 'effect-param-row');
      row.append(element('div', 'effect-param-title', `${displayName}${displayName === id ? '' : ` · ${id}`}`), element('div', 'effect-param-desc', definition?.description || t('unknownEffect')));
      const grid = element('div', 'effect-param-grid');
      const controls = [
        ['value', inputControl(value.value, 'number'), 'value', true],
        ['duration', inputControl(value.duration), 'duration', false],
        ['target', selectControl(value.target, ['enemy', 'ally', 'self']), 'target', false],
        ['count', inputControl(value.count, 'number'), 'count', true],
      ];
      for (const [label, input, key, number] of controls) {
        const wrapper = element('label', '', label);
        input.addEventListener('change', () => { value[key] = number ? Number(input.value || 0) : input.value; });
        wrapper.appendChild(input);
        grid.appendChild(wrapper);
      }
      row.appendChild(grid);
      params.appendChild(row);
    }
  };
  select.addEventListener('change', renderParams);
  renderParams();
  return {
    element: editor,
    getValue: () => {
      const selected = [...select.selectedOptions].map((option) => option.value);
      if (idsOnly) return selected;
      return selected.map((id) => ({ ...normalizeInitial(id), ...(values.get(id) || {}), effect_id: id }));
    },
  };
}

function showModal(title, build, onSubmit, saveText) {
  $('modalTitle').textContent = title;
  $('modalError').textContent = '';
  clear($('modalBody'));
  const form = element('div', 'form-grid');
  const controls = build(form) || {};
  $('modalBody').appendChild(form);
  const actionLabel = saveText || t('save');
  const actionKind = actionLabel === t('add') ? 'action-add' : actionLabel === t('modify') ? 'action-edit' : 'action-save';
  const actionIcon = actionLabel === t('add') ? '＋ ' : actionLabel === t('modify') ? '✎ ' : '✓ ';
  $('modalSave').className = `action-button ${actionKind}`;
  $('modalSave').textContent = actionIcon + actionLabel;
  modalSubmit = () => onSubmit(controls);
  $('modalBackdrop').classList.add('show');
  form.querySelector('input,select,textarea')?.focus();
}
function closeModal() { $('modalBackdrop').classList.remove('show'); $('modalError').textContent = ''; modalSubmit = null; }
function submitModal() { if (!modalSubmit) return; try { modalSubmit(); } catch (error) { $('modalError').textContent = error.message || String(error); } }
function skillTypeOptions() { return ['普通攻击', '战技', '连携技', '终结技', '天赋', '潜能']; }

function showSkillEditor(character, skill) {
  const editing = !!skill;
  const synced = editing && skill.source !== 'custom';
  const value = skill || { skillId: `${character.characterId}_skill`, name: '', skillType: '战技', element: character.element, description: '', damageMultiplier: '', staggerValue: 0, cooldown: '', spiritCost: 0, effects: [] };
  showModal(editing ? t('modifySkill') : t('addSkill'), (form) => {
    const controls = {
      skillId: inputControl(value.skillId), name: inputControl(value.name), skillType: selectControl(value.skillType, skillTypeOptions()),
      element: inputControl(value.element), damageMultiplier: inputControl(value.damageMultiplier), staggerValue: inputControl(value.staggerValue, 'number'),
      cooldown: inputControl(value.cooldown), spiritCost: inputControl(value.spiritCost, 'number'), description: textareaControl(value.description), effects: createEffectEditor(value.effects, false),
    };
    if (synced) {
      const notice = element('div', 'locked-notice', `🔒 ${t('syncedSkillLocked')}`);
      notice.setAttribute('role', 'note');
      form.append(notice, formField(t('skillId'), readonlyControl(value.skillId)), formField(t('skillName'), readonlyControl(value.name)), formField(t('skillType'), readonlyControl(value.skillType)), formField(t('element'), readonlyControl(value.element)));
    } else {
      form.append(formField(t('skillId'), controls.skillId), formField(t('skillName'), controls.name), formField(t('skillType'), controls.skillType), formField(t('element'), controls.element));
    }
    form.append(formField(t('damageMultiplier'), controls.damageMultiplier), formField(t('staggerValue'), controls.staggerValue), formField(t('cooldownField'), controls.cooldown), formField(t('spiritCostField'), controls.spiritCost), formField(t('skillDescription'), synced ? readonlyControl(value.description, true) : controls.description, true), formField(t('baseEffectsMulti'), controls.effects.element, true));
    return controls;
  }, (controls) => mutate({
    action: editing ? 'updateSkill' : 'addSkill', characterId: character.characterId, skillId: editing ? skill.skillId : undefined,
    data: { skillId: controls.skillId.value, name: controls.name.value, skillType: controls.skillType.value, element: controls.element.value, damageMultiplier: controls.damageMultiplier.value, staggerValue: Number(controls.staggerValue.value || 0), cooldown: controls.cooldown.value, spiritCost: Number(controls.spiritCost.value || 0), description: controls.description.value, effects: controls.effects.getValue() },
  }), editing ? t('modify') : t('add'));
}

function showEnhancementEditor(character, skill, enhancement, index) {
  const editing = !!enhancement;
  const value = enhancement || { name: '', triggerText: '', triggerEffectMode: 'all', triggerEffects: [], effects: [], enhancementEffect: '', visiblePulse: false };
  showModal(editing ? t('modifyEnhancement') : t('addEnhancement'), (form) => {
    const controls = { name: inputControl(value.name), triggerText: textareaControl(value.triggerText), triggerEffectMode: selectControl(value.triggerEffectMode || 'all', ['all', 'any']), enhancementEffect: textareaControl(value.enhancementEffect), triggerEffects: createEffectEditor(value.triggerEffects, true), effects: createEffectEditor(value.effects, false), visiblePulse: document.createElement('input') };
    controls.visiblePulse.type = 'checkbox';
    controls.visiblePulse.checked = value.visiblePulse === true;
    const check = element('label', 'form-check');
    check.append(controls.visiblePulse, element('span', '', t('visiblePulse')));
    const modeRow = element('div', 'form-field');
    const modeLabel = element('label', '', t('triggerEffectMode'));
    modeLabel.appendChild(controls.triggerEffectMode);
    const modeHint = element('span', 'item-sub', controls.triggerEffectMode.value === 'any' ? t('triggerEffectModeAnyHint') : t('triggerEffectModeAllHint'));
    controls.triggerEffectMode.addEventListener('change', () => { modeHint.textContent = controls.triggerEffectMode.value === 'any' ? t('triggerEffectModeAnyHint') : t('triggerEffectModeAllHint'); });
    modeRow.append(modeLabel, modeHint);
    form.append(formField(t('enhancementName'), controls.name), formField(t('visibleMarker'), check), formField(t('triggerText'), controls.triggerText, true), formField(t('enhancementDescription'), controls.enhancementEffect, true), modeRow, formField(t('triggerEffectsMulti'), controls.triggerEffects.element, true), formField(t('outputEffectsMulti'), controls.effects.element, true));
    return controls;
  }, (controls) => mutate({ action: editing ? 'updateEnhancement' : 'addEnhancement', characterId: character.characterId, skillId: skill.skillId, enhancementIndex: editing ? index : undefined, data: { name: controls.name.value, triggerText: controls.triggerText.value, triggerEffectMode: controls.triggerEffectMode.value, enhancementEffect: controls.enhancementEffect.value, triggerEffects: controls.triggerEffects.getValue(), effects: controls.effects.getValue(), visiblePulse: controls.visiblePulse.checked } }), editing ? t('modify') : t('add'));
}
function showEffectCategoryEditor() {
  showModal(t('addEffectCategory'), (form) => { const controls = { category: inputControl('') }; form.appendChild(formField(t('categoryName'), controls.category, true)); return controls; }, (controls) => mutateEffect({ action: 'addCategory', data: { category: controls.category.value } }), t('add'));
}
function showEffectEditor() {
  const categories = [...new Set((snapshot.effectCategories || snapshot.effects.map((effect) => effect.category)).filter((category) => category && category !== '__undefined__'))].sort();
  showModal(t('addEffect'), (form) => { const controls = { effectId: inputControl(''), description: textareaControl(''), category: selectControl(categories[0] || '', categories) }; form.append(formField(t('effectId'), controls.effectId), formField(t('effectCategory'), controls.category), formField(t('effectDescription'), controls.description, true)); return controls; }, (controls) => mutateEffect({ action: 'addEffect', data: { effectId: controls.effectId.value, category: controls.category.value, description: controls.description.value } }), t('add'));
}
function confirmDelete(label, callback) { if (confirm(t('confirmDelete', { name: label }))) callback(); }

function setTab(tab) {
  activeTab = tab;
  for (const node of document.querySelectorAll('.tab')) node.classList.toggle('active', node.dataset.tab === tab);
  for (const node of document.querySelectorAll('.view')) node.classList.remove('active');
  $(`${tab}View`).classList.add('active');
  saveState();
  applyAllFilters();
}
function renderSummary() {
  const summary = snapshot.summary;
  const metrics = [[t('charactersMetric'), summary.characters, ''], [t('skillsMetric'), summary.skills, ''], [t('enhancementsMetric'), summary.enhancements, ''], [t('effectReferencesMetric'), summary.effectReferences, ''], [t('effectDefinitionsMetric'), summary.definedEffects, ''], [t('error'), summary.errors, summary.errors ? 'error' : ''], [t('warning'), summary.warnings, summary.warnings ? 'warning' : '']];
  clear($('summary'));
  for (const [label, value, className] of metrics) {
    const card = element('div', `metric ${className}`);
    card.append(element('div', 'metric-value', value), element('div', 'metric-label', label));
    $('summary').appendChild(card);
  }
  $('charactersBadge').textContent = summary.characters;
  $('effectsBadge').textContent = snapshot.effects.length;
  $('localesBadge').textContent = summary.locales.length;
  $('issuesBadge').textContent = summary.errors + summary.warnings + summary.infos;
}
function fillSelect(select, values, label) {
  const selected = select.value;
  select.replaceChildren(new Option(label, ''));
  for (const value of [...new Set(values.filter(Boolean))].sort((a, b) => text(a).localeCompare(text(b)))) select.appendChild(new Option(value, value));
  if ([...select.options].some((option) => option.value === selected)) select.value = selected;
}
function setupFilters() {
  fillSelect($('starFilter'), snapshot.characters.map((item) => item.star ? String(item.star) : t('unknownStar')), t('allStars'));
  fillSelect($('elementFilter'), snapshot.characters.map((item) => item.element || t('unknownElement')), t('allElements'));
  fillSelect($('professionFilter'), snapshot.characters.map((item) => item.profession || t('unknownProfession')), t('allProfessions'));
  fillSelect($('skillTypeFilter'), snapshot.characters.flatMap((item) => item.skills.map((skill) => skill.skillType)), t('allSkillTypes'));
  fillSelect($('effectCategory'), snapshot.effectCategories || snapshot.effects.map((item) => item.category).filter((category) => category !== '__undefined__'), t('allCategories'));
}
function characterHaystack(character) {
  const localeText = Object.values(character.locales || {}).join(' ');
  const skillText = character.skills.map((skill) => [skill.skillId, skill.name, skill.skillType, skill.element, skill.description, ...skill.effects.flatMap((effect) => [effect.effectId, effect.displayName]), ...skill.enhancements.flatMap((enhancement) => [enhancement.name, enhancement.triggerText, enhancement.enhancementEffect, ...enhancement.triggerEffects.flatMap((effect) => [effect.effectId, effect.displayName]), ...enhancement.effects.flatMap((effect) => [effect.effectId, effect.displayName])])].join(' ')).join(' ');
  return normalized([character.characterId, character.name, character.master?.en, localeText, character.element, character.profession, character.weaponType, skillText].join(' '));
}
function filteredCharacters() {
  const query = currentQuery();
  return snapshot.characters.filter((character) => {
    if (query && !characterHaystack(character).includes(query)) return false;
    if ($('starFilter').value && String(character.star || t('unknownStar')) !== $('starFilter').value) return false;
    if ($('elementFilter').value && (character.element || t('unknownElement')) !== $('elementFilter').value) return false;
    if ($('professionFilter').value && (character.profession || t('unknownProfession')) !== $('professionFilter').value) return false;
    if ($('skillTypeFilter').value && !character.skills.some((skill) => skill.skillType === $('skillTypeFilter').value)) return false;
    if ($('enhancementOnly').checked && !character.skills.some((skill) => skill.enhancements.length)) return false;
    return !$('issueOnly').checked || !!character.issueCount;
  });
}

function renderCharacterList() {
  const characters = filteredCharacters();
  $('characterCount').textContent = t('characterCount', { shown: characters.length, total: snapshot.characters.length });
  clear($('characterList'));
  if (!characters.length) { $('characterList').appendChild(element('div', 'empty', t('noCharacters'))); renderCharacterDetail(null); return; }
  if (!characters.some((item) => item.characterId === selectedCharacterId)) selectedCharacterId = characters[0].characterId;
  for (const character of characters) {
    const item = element('div', `character-item${character.characterId === selectedCharacterId ? ' selected' : ''}`);
    item.dataset.id = character.characterId;
    const main = element('div', 'item-main');
    main.append(element('div', 'item-name', character.name), element('div', 'item-sub', [character.star ? `${character.star}★` : t('unknownStar'), character.element || t('unknownElement'), character.profession || t('unknownProfession')].join(' · ')));
    const stats = element('div', 'item-count', `${character.skills.length} / ${character.skills.reduce((sum, skill) => sum + skill.enhancements.length, 0)}`);
    if (character.issueCount) stats.appendChild(element('span', `issue-dot ${character.errorCount ? 'error' : ''}`, character.issueCount));
    item.append(characterAvatar(character), main, stats);
    item.addEventListener('click', () => { selectedCharacterId = character.characterId; saveState(); renderCharacterList(); renderCharacterDetail(character); });
    $('characterList').appendChild(item);
  }
  renderCharacterDetail(characters.find((item) => item.characterId === selectedCharacterId) || characters[0]);
}
function characterAvatar(character, large = false) {
  const avatar = element('div', `avatar${large ? ' avatar-large' : ''}`, character.name.slice(0, 1));
  const url = avatars[character.characterId];
  if (!url) return avatar;
  const image = document.createElement('img');
  image.src = url;
  image.alt = character.name;
  image.loading = 'lazy';
  image.decoding = 'async';
  avatar.textContent = '';
  avatar.appendChild(image);
  image.addEventListener('error', () => {
    image.remove();
    avatar.textContent = character.name.slice(0, 1);
  }, { once: true });
  return avatar;
}
function makeChip(label, className, title, onClick) {
  const chip = element('span', `chip ${className || ''}`, label);
  if (title) chip.title = title;
  if (onClick) chip.addEventListener('click', onClick);
  return chip;
}
function effectDescription(effectId) { return snapshot.effects.find((item) => item.id === effectId)?.description || t('undefinedEffect'); }
function effectDisplayName(effectId, fallback) { const effect = snapshot.effects.find((item) => item.id === effectId); return fallback || effect?.displayName || effect?.description || effectId; }
function isNegativeEffect(effect) {
  const definition = snapshot.effects.find((item) => item.id === effect.effectId);
  const category = definition?.category || '';
  return (typeof effect.count === 'number' && effect.count < 0)
    || /^(?:CONSUME_|CLEAR_|DEBUFF_)/.test(effect.effectId)
    || category.includes('减益')
    || category.includes('消耗')
    || category.includes('清除');
}
function focusEffect(effectId) { setTab('effects'); $('effectSearch').value = effectId; renderEffects(); }
function appendEffectChips(container, effects) {
  if (!effects.length) { container.appendChild(element('span', 'item-sub', t('none'))); return; }
  for (const effect of effects) {
    const displayName = effectDisplayName(effect.effectId, effect.displayName);
    const suffix = [effect.value !== undefined && effect.value !== null ? `${t('valueLabel')}=${effect.value}` : '', effect.duration !== undefined && effect.duration !== null && effect.duration !== '' ? `duration=${effect.duration}` : '', effect.count !== undefined ? `count=${effect.count}` : '', effect.target ? `target=${effect.target}` : ''].filter(Boolean).join(' · ');
    const title = `${displayName}${displayName === effect.effectId ? '' : `\n${effect.effectId}`}\n${effectDescription(effect.effectId)}${suffix ? `\n${suffix}` : ''}${effect.inferred ? `\n${t('inferredFromTriggerText')}` : ''}`;
    const chip = makeChip('', `effect ${!effect.known ? 'unknown ' : ''}${effect.inferred ? 'inferred ' : ''}${isNegativeEffect(effect) ? 'negative' : ''}`, title, () => focusEffect(effect.effectId));
    chip.appendChild(element('span', 'effect-chip-name', displayName));
    if (displayName !== effect.effectId) chip.appendChild(element('span', 'effect-chip-id', effect.effectId));
    if (typeof effect.count === 'number') chip.appendChild(element('span', 'effect-chip-count', `count=${effect.count}`));
    container.appendChild(chip);
  }
}

function renderCharacterDetail(character) {
  clear($('characterDetail'));
  if (!character) { $('characterDetail').appendChild(element('div', 'empty', t('selectCharacter'))); return; }
  const header = element('div', 'character-header');
  const left = element('div', 'character-identity');
  const identityText = element('div');
  identityText.append(element('div', 'character-title', character.name), element('div', 'character-id', character.characterId + (character.master?.en ? ` · ${character.master.en}` : '')));
  const meta = element('div', 'chips');
  for (const value of [character.star ? `${character.star}★` : t('unknownStar'), character.element || t('unknownElement'), character.profession || t('unknownProfession'), character.weaponType || t('unknownWeapon'), t('skillsCount', { count: character.skills.length }), t('enhancementsCount', { count: character.skills.reduce((sum, skill) => sum + skill.enhancements.length, 0) })]) meta.appendChild(makeChip(value));
  identityText.appendChild(meta);
  const locales = element('div', 'locales-inline');
  for (const locale of snapshot.summary.locales.slice(0, 6)) { const row = element('div', 'locale-name'); row.append(element('span', 'locale-key', locale), element('span', 'locale-value', character.locales[locale] || '—')); locales.appendChild(row); }
  identityText.appendChild(locales);
  left.append(characterAvatar(character, true), identityText);
  const actions = element('div', 'character-actions');
  actions.appendChild(button(`↗ ${t('openCharacterJson')}`, 'action-button action-open', () => postOpen('character', { characterId: character.characterId }), t('openSource')));
  header.append(left, actions);
  $('characterDetail').appendChild(header);
  if (!character.skills.length) { $('characterDetail').appendChild(element('div', 'empty', t('noSkills'))); return; }
  const sectionTitle = element('div', 'section-title');
  sectionTitle.append(element('span', '', t('skillsAndEnhancements')), button(`＋ ${t('addSkill')}`, 'action-button action-add compact', () => showSkillEditor(character, null)));
  $('characterDetail').appendChild(sectionTitle);
  for (const skill of character.skills) {
    const card = element('article', 'skill-card');
    const head = element('div', 'skill-head');
    const title = element('div');
    title.appendChild(element('div', 'skill-name', skill.name));
    const id = element('div', 'skill-id clickable-id', skill.skillId);
    id.title = t('clickCopySkillId'); id.addEventListener('click', () => postCopy(skill.skillId)); title.appendChild(id); head.appendChild(title);
    const skillMeta = element('div', 'skill-meta');
    skillMeta.appendChild(makeChip(skill.skillType));
    if (skill.element) skillMeta.appendChild(makeChip(skill.element));
    if (skill.hasEnhancement) skillMeta.appendChild(makeChip(t('enhancedState')));
    skillMeta.appendChild(button(`✎ ${t('modify')}`, 'action-button action-edit compact', () => showSkillEditor(character, skill), t('modifySkill')));
    if (skill.source === 'custom') skillMeta.appendChild(button(`× ${t('delete')}`, 'action-button action-delete compact', () => confirmDelete(skill.name, () => mutate({ action: 'deleteSkill', characterId: character.characterId, skillId: skill.skillId }))));
    else skillMeta.appendChild(makeChip(t('syncedSkillLocked')));
    skillMeta.appendChild(button(`↗ ${t('open')}`, 'action-button action-open compact', () => postOpen('character', { characterId: character.characterId, skillId: skill.skillId }), t('openSource')));
    head.appendChild(skillMeta); card.appendChild(head);
    const body = element('div', 'skill-body');
    if (skill.description) body.appendChild(element('div', 'description', skill.description));
    const kv = element('div', 'kv-grid');
    const values = [[t('multiplier'), skill.damageMultiplier], [t('stagger'), skill.staggerValue || ''], [t('cooldown'), skill.cooldown], [t('spiritCost'), skill.spiritCost || '']].filter((entry) => entry[1] !== '');
    for (const [key, value] of values) { const node = element('div'); node.append(element('span', 'kv-key', key), element('span', '', value)); kv.appendChild(node); }
    if (values.length) body.appendChild(kv);
    const effects = element('div', 'effect-line'); const effectChips = element('div', 'chips'); appendEffectChips(effectChips, skill.effects); effects.append(element('div', 'line-label', t('baseEffects')), effectChips); body.appendChild(effects);
    for (let index = 0; index < skill.enhancements.length; index++) {
      const enhancement = skill.enhancements[index];
      const block = element('section', 'enhancement'); const enhancementHead = element('div', 'enhancement-head'); const name = element('div', 'enhancement-name', enhancement.name);
      if (enhancement.visiblePulse) name.appendChild(element('span', 'pulse', t('visiblePulse')));
      const enhancementActions = element('div', 'enhancement-actions');
      enhancementActions.append(button(`✎ ${t('modify')}`, 'action-button action-edit compact', () => showEnhancementEditor(character, skill, enhancement, index), t('modifyEnhancement')), button(`× ${t('delete')}`, 'action-button action-delete compact', () => confirmDelete(enhancement.name, () => mutate({ action: 'deleteEnhancement', characterId: character.characterId, skillId: skill.skillId, enhancementIndex: index }))));
      enhancementHead.append(name, enhancementActions); block.appendChild(enhancementHead);
      if (enhancement.triggerText) block.appendChild(element('div', 'enhancement-trigger', enhancement.triggerText));
      if (enhancement.enhancementEffect) block.appendChild(element('div', 'item-sub', enhancement.enhancementEffect));
      const anySvg = '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round"><path d="M12 3v4"/><path d="M8 7l4 4 4-4"/><path d="M6 14l6 5 6-5" opacity=".5"/><circle cx="12" cy="20" r="1.5" fill="currentColor" stroke="none"/></svg>';
      const allSvg = '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round"><path d="M5 12h14"/><path d="M9 8l-4 4 4 4"/><path d="M15 8l4 4-4 4"/><circle cx="5" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.5" fill="currentColor" stroke="none"/></svg>';
      for (const [label, refs, mode] of [[t('triggerEffects'), enhancement.triggerEffects, enhancement.triggerEffectMode], [t('outputEffects'), enhancement.effects, null]]) {
        if (mode) {
          if (refs.length <= 1) {
            const line = element('div', 'effect-line');
            const chips = element('div', 'chips');
            if (refs.length === 1) appendEffectChips(chips, refs);
            else chips.textContent = `(${t('noTriggerEffects')})`;
            line.append(element('div', 'line-label', label), chips);
            block.appendChild(line);
          } else {
            const wrap = element('div', `trigger-mode-wrap mode-${mode}`);
            wrap.title = mode === 'any' ? t('triggerEffectModeAnyHint') : t('triggerEffectModeAllHint');
            const iconCol = element('div', 'trigger-mode-icon');
            iconCol.innerHTML = mode === 'any' ? anySvg : allSvg;
            const lbl = element('div', 'trigger-mode-label', mode === 'any' ? 'ANY' : 'ALL');
            iconCol.appendChild(lbl);
            const body = element('div', 'trigger-mode-body');
            const chips = element('div', 'chips');
            appendEffectChips(chips, refs);
            body.appendChild(element('div', 'line-label', label));
            body.appendChild(chips);
            wrap.append(iconCol, body);
            block.appendChild(wrap);
          }
        } else {
          const line = element('div', 'effect-line');
          const chips = element('div', 'chips');
          appendEffectChips(chips, refs);
          line.append(element('div', 'line-label', label), chips);
          block.appendChild(line);
        }
      }
      body.appendChild(block);
    }
    body.appendChild(button(`＋ ${t('addEnhancement')}`, 'action-button action-add compact add-enhancement-action', () => showEnhancementEditor(character, skill, null, -1)));
    card.appendChild(body); $('characterDetail').appendChild(card);
  }
}

function effectHaystack(effect) { return normalized([effect.id, effect.displayName, effect.description, effect.category, ...effect.usages.flatMap((usage) => [usage.characterName, usage.skillName, usage.enhancementName, usage.scope])].join(' ')); }
function renderEffects() {
  if (!snapshot) return;
  const query = normalized($('effectSearch').value.trim() || (activeTab === 'effects' ? $('globalSearch').value.trim() : ''));
  const effects = snapshot.effects.filter((effect) => (!query || effectHaystack(effect).includes(query)) && (!$('effectCategory').value || effect.category === $('effectCategory').value) && ($('effectUsage').value !== 'used' || effect.usages.length) && ($('effectUsage').value !== 'unused' || !effect.usages.length) && ($('effectUsage').value !== 'unknown' || !effect.defined));
  $('effectCount').textContent = t('effectsCount', { shown: effects.length, total: snapshot.effects.length }); clear($('effectList'));
  if (!effects.length) { $('effectList').appendChild(element('div', 'empty', t('noEffects'))); return; }
  for (const effect of effects) {
    const card = element('div', 'effect-card'); const left = element('div'); left.appendChild(element('div', 'effect-name', effect.displayName || effect.description || effect.id));
    const id = element('div', 'effect-id clickable-id', effect.id); id.title = t('clickCopyEffectId'); id.addEventListener('click', () => postCopy(effect.id)); left.append(id, element('div', 'item-sub', `${effect.category === '__undefined__' ? t('undefinedEffect') : effect.category}${effect.defined ? '' : ` · ${t('undefinedEffect')}`}`));
    const usageList = element('div', 'usage-list'); const shown = effect.usages.slice(0, 8);
    for (const usage of shown) { const node = element('div', 'usage', `${usage.characterName} / ${usage.skillName}${usage.enhancementName ? ` / ${usage.enhancementName}` : ''} · ${usage.scope}`); node.addEventListener('click', () => { selectedCharacterId = usage.characterId; $('globalSearch').value = ''; for (const filter of ['starFilter', 'elementFilter', 'professionFilter', 'skillTypeFilter']) $(filter).value = ''; $('enhancementOnly').checked = false; $('issueOnly').checked = false; setTab('characters'); renderCharacterList(); }); usageList.appendChild(node); }
    if (effect.usages.length > shown.length) usageList.appendChild(element('div', 'item-sub', t('moreUsages', { count: effect.usages.length - shown.length })));
    left.appendChild(usageList); card.append(left, element('div', 'effect-desc', effect.description), button(`↗ ${t('openDefinition')}`, 'action-button action-open compact', () => postOpen('effects', { effectId: effect.id }))); $('effectList').appendChild(card);
  }
}
function renderLocales() {
  if (!snapshot) return; const query = currentQuery(); const characters = snapshot.characters.filter((character) => !query || characterHaystack(character).includes(query)); clear($('localeTable'));
  const table = element('table'); const head = element('thead'); const headRow = element('tr'); headRow.appendChild(element('th', 'sticky', t('characterIdColumn'))); for (const locale of snapshot.summary.locales) headRow.appendChild(element('th', '', locale)); head.appendChild(headRow); table.appendChild(head); const body = element('tbody');
  for (const character of characters) { const row = element('tr'); const first = element('td', 'sticky'); const name = element('div', 'item-name clickable-name', character.name); name.title = t('openCharacterLocaleFile'); name.addEventListener('click', () => postOpen('locale', { characterId: character.characterId })); first.append(name, element('div', 'item-sub', character.characterId)); row.appendChild(first); for (const locale of snapshot.summary.locales) { const value = character.locales[locale] || ''; row.appendChild(element('td', value ? '' : 'missing-cell', value || t('missing'))); } body.appendChild(row); }
  table.appendChild(body); $('localeTable').appendChild(table);
}
function sourcePayload(source) { return source ? { kind: source.kind, characterId: source.characterId, fileName: source.fileName, effectId: source.effectId, skillId: source.skillId } : null; }
function renderIssues() {
  if (!snapshot) return; const query = normalized($('issueSearch').value.trim() || (activeTab === 'issues' ? $('globalSearch').value.trim() : '')); const issues = snapshot.issues.filter((issue) => (!$('issueSeverity').value || issue.severity === $('issueSeverity').value) && (!query || normalized([issue.code, issue.message, issue.source?.characterId, issue.source?.skillId, issue.source?.effectId].join(' ')).includes(query))); $('issueCount').textContent = t('issuesCount', { shown: issues.length, total: snapshot.issues.length }); clear($('issueList'));
  if (!issues.length) { $('issueList').appendChild(element('div', 'empty', snapshot.issues.length ? t('noIssuesMatch') : t('noIssues'))); return; }
  for (const issue of issues) { const row = element('div', 'issue-row'); row.append(element('div', `severity ${issue.severity}`, issue.severity), element('div', 'issue-code', issue.code), element('div', '', issue.message)); const payload = sourcePayload(issue.source); row.appendChild(payload ? button(`↗ ${t('openSource')}`, 'action-button action-open compact', () => postOpen(payload.kind, payload)) : element('span')); $('issueList').appendChild(row); }
}
function applyAllFilters() { if (!snapshot) return; if (activeTab === 'characters') renderCharacterList(); else if (activeTab === 'effects') renderEffects(); else if (activeTab === 'locales') renderLocales(); else renderIssues(); }
function renderData(data, avatarMap = {}) { snapshot = data; avatars = avatarMap; $('project').textContent = data.projectDir; $('fatal').classList.remove('show'); $('loading').classList.remove('show'); renderSummary(); setupFilters(); if (!selectedCharacterId || !data.characters.some((item) => item.characterId === selectedCharacterId)) selectedCharacterId = data.characters[0]?.characterId || ''; setTab(activeTab); }

localizeStaticUi();
for (const tab of document.querySelectorAll('.tab')) tab.addEventListener('click', () => setTab(tab.dataset.tab));
$('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
$('globalSearch').addEventListener('input', applyAllFilters);
for (const id of ['starFilter', 'elementFilter', 'professionFilter', 'skillTypeFilter', 'enhancementOnly', 'issueOnly']) $(id).addEventListener('change', renderCharacterList);
for (const id of ['effectSearch', 'effectCategory', 'effectUsage']) $(id).addEventListener(id === 'effectSearch' ? 'input' : 'change', renderEffects);
$('addEffectCategory').addEventListener('click', showEffectCategoryEditor); $('addEffect').addEventListener('click', showEffectEditor); $('issueSearch').addEventListener('input', renderIssues); $('issueSeverity').addEventListener('change', renderIssues); $('modalClose').addEventListener('click', closeModal); $('modalCancel').addEventListener('click', closeModal); $('modalSave').addEventListener('click', submitModal); $('modalBackdrop').addEventListener('click', (event) => { if (event.target === $('modalBackdrop')) closeModal(); });
window.addEventListener('keydown', (event) => { if (event.key === 'Escape' && $('modalBackdrop').classList.contains('show')) closeModal(); });
window.addEventListener('message', (event) => {
  const message = event.data;
  if (message.type === 'loading') { $('project').textContent = message.projectDir || ''; $('loading').classList.add('show'); $('fatal').classList.remove('show'); }
  else if (message.type === 'data') renderData(message.snapshot, message.avatars || {});
  else if (message.type === 'error') { $('loading').classList.remove('show'); $('fatal').textContent = message.text || t('loadFailed'); $('fatal').classList.add('show'); }
  else if (message.type === 'mutationResult') { if (message.ok) closeModal(); else $('modalError').textContent = message.text || t('saveFailed'); }
});
vscode.postMessage({ type: 'ready' });
