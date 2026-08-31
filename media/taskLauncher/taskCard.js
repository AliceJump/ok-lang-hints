(() => {
  const { t, post, state, taskKey } = globalThis.TaskLauncherCore;
  const { buildConfigPanel } = globalThis.TaskLauncherConfigPanel;

  function createButton(className, text, handler) {
    const button = document.createElement('button');
    button.className = className;
    button.textContent = text;
    button.addEventListener('click', handler);
    return button;
  }

  function buildTaskCard(task) {
    const key = taskKey(task);
    const schema = state.schemas[key];
    const displayName = schema?.displayName || task.displayName;

    const card = document.createElement('article');
    card.className = 'task-card';
    card.dataset.taskKey = key;

    const header = document.createElement('header');
    header.className = 'task-card__header';
    const identity = document.createElement('div');
    identity.className = 'task-card__identity';
    const titleRow = document.createElement('div');
    titleRow.className = 'task-card__title-row';
    const name = document.createElement('div');
    name.className = 'task-card__name';
    name.textContent = displayName;
    name.title = task.module;
    titleRow.appendChild(name);
    if (schema?.kind) {
      const kind = document.createElement('span');
      kind.className = 'task-card__kind';
      kind.textContent = schema.kind === 'trigger' ? t('triggerTask') : t('oneTimeTask');
      titleRow.appendChild(kind);
    }
    const className = document.createElement('div');
    className.className = 'task-card__class';
    className.textContent = `${task.className} · ${task.module}`;
    identity.append(titleRow, className);
    if (schema?.description) {
      const description = document.createElement('div');
      description.className = 'task-card__description';
      description.textContent = schema.description;
      identity.appendChild(description);
    }

    const actions = document.createElement('div');
    actions.className = 'task-card__actions';
    const launch = createButton('task-card__launch', `▶ ${t('launch')}`, () => {
      if (state.running) return;
      post({ type: 'launch', task: { ...task, displayName } });
    });
    launch.dataset.role = 'launch';
    const stop = createButton('task-card__stop secondary', `⏹ ${t('stop')}`, () => {
      if (!state.running) return;
      post({ type: 'stop', task: { ...task, displayName } });
    });
    stop.dataset.role = 'stop';
    actions.append(launch, stop);
    header.append(identity, actions);

    const configPanel = buildConfigPanel(task, schema);
    if (state.openPanels.has(key)) configPanel.classList.add('open');
    const footer = document.createElement('footer');
    footer.className = 'task-card__footer';
    const configToggle = createButton(
      'task-card__config-toggle secondary',
      configPanel.classList.contains('open') ? `▲ ${t('collapseParameters')}` : `⚙ ${t('parameters')}`,
      () => {
        const open = configPanel.classList.toggle('open');
        if (open) state.openPanels.add(key); else state.openPanels.delete(key);
        configToggle.textContent = open ? `▲ ${t('collapseParameters')}` : `⚙ ${t('parameters')}`;
      },
    );
    footer.appendChild(configToggle);
    card.append(header, footer, configPanel);
    return card;
  }

  function updateRunningState() {
    for (const card of globalThis.TaskLauncherCore.elements.tasks.querySelectorAll('.task-card')) {
      const current = card.dataset.taskKey === state.runningTaskKey;
      card.classList.toggle('is-running', state.running && current);
      const launch = card.querySelector('[data-role="launch"]');
      const stop = card.querySelector('[data-role="stop"]');
      launch.disabled = state.running;
      launch.textContent = state.running && current ? `⏳ ${t('running')}` : `▶ ${t('launch')}`;
      stop.disabled = !state.running || !current;
    }
  }

  function renderTasks(tasks) {
    state.currentTasks = tasks;
    const fragment = document.createDocumentFragment();
    for (const task of tasks) fragment.appendChild(buildTaskCard(task));
    globalThis.TaskLauncherCore.elements.tasks.replaceChildren(fragment);
    globalThis.TaskLauncherCore.elements.empty.hidden = tasks.length > 0;
    updateRunningState();
  }

  globalThis.TaskLauncherTaskCard = { renderTasks, updateRunningState };
})();
