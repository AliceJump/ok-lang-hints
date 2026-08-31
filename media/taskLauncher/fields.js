(() => {
  const { t } = globalThis.TaskLauncherCore;

  function currentValue(field, config) {
    return config.params && field.key in config.params
      ? config.params[field.key]
      : (field.value !== undefined ? field.value : field.default);
  }

  function createDescription(field) {
    const text = field.displayDesc || field.desc;
    if (!text) return null;
    const description = document.createElement('div');
    description.className = 'config-field__description';
    description.textContent = text;
    return description;
  }

  function createHint(text) {
    const hint = document.createElement('div');
    hint.className = 'config-field__hint';
    hint.textContent = text;
    return hint;
  }

  function createSelectOption(value, label, selected) {
    const option = document.createElement('option');
    option.value = String(value);
    option.textContent = String(label);
    option.selected = selected;
    return option;
  }

  function buildCascadeSelect(typeMeta, rawValue, setValue) {
    const select = document.createElement('select');
    let selected = false;
    for (const [category, values] of Object.entries(typeMeta.options || {})) {
      if (!Array.isArray(values)) continue;
      const group = document.createElement('optgroup');
      group.label = String(typeMeta.category_labels?.[category] || typeMeta.labels?.[category] || category);
      for (let index = 0; index < values.length; index++) {
        const value = values[index];
        const option = createSelectOption(
          JSON.stringify(value),
          typeMeta.option_labels?.[category]?.[index] || value,
          String(value) === String(rawValue),
        );
        if (option.selected) selected = true;
        group.appendChild(option);
      }
      select.appendChild(group);
    }
    if (!selected && rawValue !== undefined && rawValue !== null) {
      const group = document.createElement('optgroup');
      group.label = t('current');
      group.appendChild(createSelectOption(JSON.stringify(rawValue), t('currentValue', { value: rawValue }), true));
      select.insertBefore(group, select.firstChild);
    }
    select.addEventListener('change', () => {
      try { setValue(JSON.parse(select.value)); } catch { /* keep previous value */ }
    });
    return select;
  }

  function buildDropDown(typeMeta, options, optionLabels, rawValue, setValue) {
    const select = document.createElement('select');
    const current = String(rawValue ?? '');
    let hasCurrent = false;
    options.forEach((optionValue, index) => {
      const option = createSelectOption(index, optionLabels[index] || optionValue, String(optionValue) === current);
      if (option.selected) hasCurrent = true;
      select.appendChild(option);
    });
    if (!hasCurrent) select.appendChild(createSelectOption(-1, t('currentValue', { value: current }), true));
    select.addEventListener('change', () => {
      const index = Number(select.value);
      if (index >= 0 && index < options.length) setValue(options[index]);
    });
    return select;
  }

  function buildBoolean(rawValue, setValue) {
    const wrapper = document.createElement('label');
    wrapper.className = 'switch-field';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = Boolean(rawValue);
    const state = document.createElement('span');
    state.className = 'switch-field__state';
    const syncLabel = () => { state.textContent = checkbox.checked ? t('enabled') : t('disabled'); };
    syncLabel();
    checkbox.addEventListener('change', () => {
      syncLabel();
      setValue(checkbox.checked);
    });
    wrapper.append(checkbox, state);
    return wrapper;
  }

  function buildNumber(typeMeta, rawValue, setValue) {
    const input = document.createElement('input');
    input.type = 'number';
    input.value = String(rawValue);
    const minimum = typeMeta.minimum ?? typeMeta.min;
    const maximum = typeMeta.maximum ?? typeMeta.max;
    if (minimum !== undefined) input.min = String(minimum);
    if (maximum !== undefined) input.max = String(maximum);
    input.addEventListener('change', () => {
      const value = Number(input.value);
      setValue(Number.isNaN(value) ? 0 : value);
    });
    return input;
  }

  function buildMultiSelection(options, optionLabels, rawValue, setValue) {
    const wrapper = document.createElement('div');
    const select = document.createElement('select');
    select.multiple = true;
    select.size = Math.min(7, options.length + 1);
    const selectedValues = (Array.isArray(rawValue) ? rawValue : []).map(String);
    options.forEach((optionValue, index) => {
      select.appendChild(createSelectOption(index, optionLabels[index] || optionValue, selectedValues.includes(String(optionValue))));
    });
    select.addEventListener('change', () => {
      setValue(Array.from(select.selectedOptions).map(option => options[Number(option.value)]));
    });
    wrapper.append(select, createHint(t('holdCtrlMulti')));
    return wrapper;
  }

  function buildStructuredList(rawValue, setValue) {
    const wrapper = document.createElement('div');
    const textarea = document.createElement('textarea');
    textarea.value = JSON.stringify(Array.isArray(rawValue) ? rawValue : [], null, 2);
    textarea.addEventListener('change', () => {
      try {
        const parsed = JSON.parse(textarea.value);
        if (!Array.isArray(parsed)) throw new Error();
        textarea.classList.remove('config-json-error');
        setValue(parsed);
      } catch {
        textarea.classList.add('config-json-error');
      }
    });
    wrapper.append(textarea, createHint(t('structuredJsonHint')));
    return wrapper;
  }

  function buildList(typeMeta, rawValue, setValue) {
    const textarea = document.createElement('textarea');
    textarea.value = (Array.isArray(rawValue) ? rawValue : []).join('\n');
    const available = Array.isArray(typeMeta.options_available) ? typeMeta.options_available : [];
    if (available.length) {
      const labels = Array.isArray(typeMeta.options_available_labels) ? typeMeta.options_available_labels : available;
      textarea.title = t('selectedOptionsHint', { values: labels.map(String).join(', ') });
    }
    textarea.addEventListener('change', () => {
      setValue(textarea.value.split(/\r?\n/).map(value => value.trim()).filter(Boolean));
    });
    return textarea;
  }

  function buildText(rawValue, setValue, multiline) {
    const input = document.createElement(multiline ? 'textarea' : 'input');
    if (!multiline) input.type = 'text';
    input.value = rawValue === undefined || rawValue === null ? '' : String(rawValue);
    input.addEventListener('change', () => setValue(input.value));
    return input;
  }

  function buildField(container, field, config, onChange) {
    const row = document.createElement('div');
    row.className = 'config-field';
    row.dataset.key = field.key;

    const label = document.createElement('label');
    label.className = 'config-field__label';
    label.textContent = field.displayKey || field.key;
    label.title = field.key;
    row.appendChild(label);
    const description = createDescription(field);
    if (description) row.appendChild(description);

    const setValue = value => {
      config.params ||= {};
      config.params[field.key] = value;
      onChange?.();
    };
    const typeMeta = field.type || {};
    const typeName = String(typeMeta.type || '');
    const options = Array.isArray(typeMeta.options) ? typeMeta.options : [];
    const optionLabels = Array.isArray(typeMeta.option_labels) ? typeMeta.option_labels : [];
    const rawValue = currentValue(field, config);

    let control;
    if (typeName === 'cascade_drop_down' && typeMeta.options && typeof typeMeta.options === 'object') {
      control = buildCascadeSelect(typeMeta, rawValue, setValue);
    } else if ((typeName === 'drop_down' || (!typeName && options.length && !Array.isArray(rawValue))) && options.length) {
      control = buildDropDown(typeMeta, options, optionLabels, rawValue, setValue);
    } else if (typeof rawValue === 'boolean') {
      control = buildBoolean(rawValue, setValue);
    } else if (typeof rawValue === 'number') {
      control = buildNumber(typeMeta, rawValue, setValue);
    } else if (Array.isArray(rawValue) && (typeName === 'multi_selection' || (!typeName && options.length)) && options.length) {
      control = buildMultiSelection(options, optionLabels, rawValue, setValue);
    } else if (typeName === 'cond_sequence_editor' || (Array.isArray(rawValue) && rawValue.some(item => item && typeof item === 'object'))) {
      control = buildStructuredList(rawValue, setValue);
    } else if (Array.isArray(rawValue)) {
      control = buildList(typeMeta, rawValue, setValue);
    } else {
      const multiline = typeof rawValue === 'string' && (typeName === 'text_edit' || rawValue.includes('\n') || rawValue.length > 80);
      control = buildText(rawValue, setValue, multiline);
    }

    row.appendChild(control);
    container.appendChild(row);
    return row;
  }

  globalThis.TaskLauncherFields = { buildField, fieldValue: currentValue };
})();
