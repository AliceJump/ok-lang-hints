(() => {
  const { t, post, state, elements, taskKey, setStatus, initializeStaticUi } = globalThis.TaskLauncherCore;
  const { renderTasks, updateRunningState } = globalThis.TaskLauncherTaskCard;

  function setRunning(running, taskOrKey) {
    state.running = running;
    if (typeof taskOrKey === 'string') state.runningTaskKey = taskOrKey;
    else if (taskOrKey) state.runningTaskKey = taskKey(taskOrKey);
    if (!running) state.runningTaskKey = '';
    updateRunningState();
  }

  function handleMessage(message) {
    switch (message.type) {
      case 'tasks':
        state.schemas = message.schemas || state.schemas;
        renderTasks(message.tasks || []);
        break;
      case 'schemas':
        state.schemas = message.schemas || state.schemas;
        renderTasks(state.currentTasks);
        break;
      case 'taskConfigs':
        state.taskConfigs = message.configs || {};
        renderTasks(state.currentTasks);
        break;
      case 'status':
        setStatus(message.level, message.text);
        break;
      case 'running':
        setRunning(message.running, message.task);
        if (message.stopping) setStatus('warn', message.timedOut ? t('timeoutStopping') : t('stopping'));
        else if (message.error) setStatus('error', message.error);
        else if (message.stopped) setStatus('warn', message.timedOut ? t('taskTimedOut') : t('taskStopped'));
        else if (message.running === false && message.code === 0) setStatus('ok', t('taskCompleted'));
        else if (message.running === false) setStatus('error', t('taskFailed'));
        break;
      default:
        break;
    }
  }

  initializeStaticUi();
  elements.refresh.addEventListener('click', () => post({ type: 'refresh' }));
  window.addEventListener('message', event => handleMessage(event.data));
  post({ type: 'ready' });
  post({ type: 'loadConfigs' });
})();
