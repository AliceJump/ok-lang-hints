(() => {
  const strings = globalThis.__TASK_LAUNCHER_I18N__ || {};
  const t = (key, args = {}) => (strings[key] || key).replace(/\{(\w+)\}/g, (_, name) => String(args[name] ?? `{${name}}`));
  const vscode = acquireVsCodeApi();

  const state = {
    running: false,
    schemas: {},
    taskConfigs: {},
    currentTasks: [],
    runningTaskKey: '',
    openPanels: new Set(),
    openConfigGroups: new Map(),
  };

  const elements = {
    tasks: document.getElementById('tasks'),
    status: document.getElementById('status'),
    empty: document.getElementById('empty'),
    refresh: document.getElementById('refresh'),
  };

  const taskKey = task => `${task.module}::${task.className}`;
  const post = message => vscode.postMessage(message);

  function setStatus(level, text) {
    if (!text) {
      elements.status.hidden = true;
      elements.status.textContent = '';
      return;
    }
    elements.status.hidden = false;
    elements.status.className = `status-banner ${level || ''}`;
    elements.status.textContent = text;
  }

  function initializeStaticUi() {
    document.documentElement.lang = navigator.language || 'en';
    document.title = t('taskTitle');
    elements.refresh.textContent = '↻';
    elements.refresh.title = t('refresh');
    elements.refresh.setAttribute('aria-label', t('refresh'));
    elements.empty.textContent = t('noTasks');
  }

  globalThis.TaskLauncherCore = {
    t,
    post,
    state,
    elements,
    taskKey,
    setStatus,
    initializeStaticUi,
  };
})();
