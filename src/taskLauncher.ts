import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/** 单个任务的元信息 */
interface TaskInfo {
  module: string;
  className: string;
  /** 显示名：优先任务的 name，回退类名 */
  displayName: string;
}

/** 任务列表请求结果 */
interface TaskListResult {
  ok: boolean;
  error?: string;
  tasks?: TaskInfo[];
  /** config 模块路径：`src.config` 或 `config`（取决于 config.py 所在位置） */
  configModule?: string;
}

/**
 * 用 Python 子进程 + AST 安全解析 ok-script 项目的 src/config.py，
 * 提取 onetime_tasks / trigger_tasks 注册表，不导入任何模块。
 */
function parseConfigTasks(projectDir: string, pythonPath: string): TaskListResult {
  const script = String.raw`
import ast, json, os, sys
project_dir = ${JSON.stringify(projectDir)}

def extract_tasks(src_path):
    with open(src_path, encoding='utf-8') as f:
        tree = ast.parse(f.read())
    onetime = []
    trigger = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Dict):
            for k, v in zip(node.keys, node.values):
                if not (k and isinstance(k, ast.Constant)):
                    continue
                key = k.value
                if key not in ('onetime_tasks', 'trigger_tasks'):
                    continue
                if not isinstance(v, ast.List):
                    continue
                for el in v.elts:
                    if isinstance(el, ast.List) and len(el.elts) >= 2:
                        mod = el.elts[0].value if isinstance(el.elts[0], ast.Constant) else None
                        cls = el.elts[1].value if isinstance(el.elts[1], ast.Constant) else None
                        if mod and cls:
                            (onetime if key == 'onetime_tasks' else trigger).append(
                                {"module": mod, "class": cls})
    return onetime, trigger

# 尝试 src/config.py 或 config.py
for candidate in (os.path.join(project_dir, 'src', 'config.py'),
                  os.path.join(project_dir, 'config.py')):
    if os.path.exists(candidate):
        onetime, trigger = extract_tasks(candidate)
        # config 模块路径：src/config.py -> src.config；config.py -> config
        is_src = candidate.endswith(os.path.join('src', 'config.py'))
        config_module = 'src.config' if is_src else 'config'
        print(json.dumps({"ok": True, "project": os.path.basename(project_dir),
                          "config_module": config_module,
                          "onetime": onetime, "trigger": trigger},
                         ensure_ascii=False))
        sys.exit(0)
print(json.dumps({"ok": False, "error": f"找不到 config.py: {project_dir}"}, ensure_ascii=False))
sys.exit(1)
`;
  const args = ['-c', script];
  const env = { ...process.env };

  try {
    const result = cp.spawnSync(pythonPath, args, {
      cwd: projectDir,
      env,
      encoding: 'utf-8',
      timeout: 15000,
      // 项目可能在 .venv 下有自己的依赖，不需要继承太多
      windowsHide: true,
    });
    if (result.error) {
      return { ok: false, error: `无法运行 Python: ${result.error.message}` };
    }
    if (result.status !== 0) {
      return { ok: false, error: result.stderr?.trim() || `退出码 ${result.status}` };
    }
    // 找到最后一个 JSON 行（前面的输出可能是日志）
    const lines = (result.stdout || '').split('\n').filter(Boolean);
    let parsed: any = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        parsed = JSON.parse(lines[i]);
        break;
      } catch { /* 跳过非 JSON 行 */ }
    }
    if (!parsed || !parsed.ok) {
      return { ok: false, error: parsed?.error || '解析任务列表失败' };
    }
    const configModule = parsed.config_module || 'src.config';
    const tasks: TaskInfo[] = [
      ...(parsed.onetime || []),
      ...(parsed.trigger || []),
    ].map((t: any) => ({
      module: t.module,
      className: t['class'] || t.class,
      displayName: t.name || t['class'] || t.module,
    }));
    return { ok: true, tasks, configModule };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 运行单个任务的 shell 命令（headless，不启动 GUI） */
function buildRunArgs(taskClassName: string, configModule: string): string[] {
  // 用 python -c 直接调用 ok.run_task，避免依赖项目内 .venv 的 console script
  const code = [
    'import sys',
    'sys.path.insert(0, ".")',
    'from ok import run_task',
    `from ${configModule} import config`,
    // 过滤任务注册表：只保留目标任务，避免 TaskManager 加载其他
    // 有导入问题的任务（如 ok-end-field 的 characters 包问题）导致整体失败
    // 注意：不能直接把 trigger_tasks 清空——若目标任务本身是 trigger 任务，
    // OK.get_task 会先查 onetime_tasks 再查 trigger_tasks，清空会导致找不到。
    'config = dict(config)',
    `config['onetime_tasks'] = [t for t in config.get('onetime_tasks', []) if t[1] == ${JSON.stringify(taskClassName)}]`,
    `config['trigger_tasks'] = [t for t in config.get('trigger_tasks', []) if t[1] == ${JSON.stringify(taskClassName)}]`,
    `run_task(config, task=${JSON.stringify(taskClassName)})`,
  ].join('; ');
  return ['-c', code];
}

/** 侧边栏任务启动视图 */
export class TaskLauncherViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'okLangHints.taskLauncher';

  private readonly output: vscode.OutputChannel;
  private running = false;
  private currentTask: TaskInfo | undefined;
  private configModule = 'src.config';

  constructor(
    private readonly extensionUri: vscode.Uri,
  ) {
    this.output = vscode.window.createOutputChannel('ok-script 任务启动');
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = {
      enableScripts: true,
    };
    view.webview.html = this.buildHtml();

    view.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'ready':
          await this.refreshTasks(view);
          break;
        case 'refresh':
          await this.refreshTasks(view);
          break;
        case 'launch':
          await this.launchTask(view, msg.task);
          break;
      }
    });
  }

  /**
   * 读取配置获取项目路径和 Python 解释器。
   * 配置未填写时，自动检测当前工作区根目录（若含 src/config.py 则视为 ok-script 项目）。
   */
  private getConfig(): { projectDir: string; pythonPath: string; fromConfig: boolean } {
    const cfg = vscode.workspace.getConfiguration('okLangHints');
    let projectDir = cfg.get<string>('okScriptProjectPath') || '';
    let fromConfig = true;
    projectDir = projectDir.replace(/^~/, process.env.USERPROFILE || '');
    projectDir = projectDir.replace(/[\\/]+$/, '');

    if (!projectDir) {
      // 自动检测：工作区根目录是否本身就是 ok-script 项目
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
      if (root && (fs.existsSync(path.join(root, 'src', 'config.py')) || fs.existsSync(path.join(root, 'config.py')))) {
        projectDir = root;
        fromConfig = false;
      }
    }

    const python = cfg.get<string>('okScriptPython') || '';
    let pythonPath = python;
    if (!pythonPath) {
      const venvPy = path.join(projectDir, '.venv', 'Scripts', 'python.exe');
      pythonPath = fs.existsSync(venvPy) ? venvPy : 'python';
    }
    return { projectDir, pythonPath, fromConfig };
  }

  private async refreshTasks(view: vscode.WebviewView): Promise<void> {
    const { projectDir, pythonPath, fromConfig } = this.getConfig();
    if (!projectDir) {
      void view.webview.postMessage({
        type: 'status',
        level: 'warn',
        text: '未找到 ok-script 项目。请在设置中填写 okLangHints.okScriptProjectPath，或打开含 src/config.py 的 ok-script 项目文件夹。',
      });
      return;
    }
    if (!fs.existsSync(projectDir)) {
      void view.webview.postMessage({
        type: 'status',
        level: 'warn',
        text: `项目目录不存在: ${projectDir}`,
      });
      return;
    }
    const result = parseConfigTasks(projectDir, pythonPath);
    if (!result.ok) {
      void view.webview.postMessage({
        type: 'status',
        level: 'error',
        text: `任务列表加载失败: ${result.error}`,
      });
      return;
    }
    if (result.configModule) this.configModule = result.configModule;
    await view.webview.postMessage({ type: 'tasks', tasks: result.tasks });
    void view.webview.postMessage({
      type: 'status',
      level: 'ok',
      text: `${fromConfig ? '' : '自动检测到工作区项目 · '}已加载 ${result.tasks?.length ?? 0} 个任务`,
    });
  }

  private async launchTask(view: vscode.WebviewView, task: TaskInfo): Promise<void> {
    if (this.running) {
      void vscode.window.showWarningMessage('已有任务在运行，请先等待完成或停止。');
      return;
    }
    const { projectDir, pythonPath } = this.getConfig();
    if (!projectDir) {
      void vscode.window.showErrorMessage('未配置 ok-script 项目路径。');
      return;
    }
    if (!fs.existsSync(projectDir)) {
      void vscode.window.showErrorMessage(`项目目录不存在: ${projectDir}`);
      return;
    }
    if (!fs.existsSync(pythonPath) && pythonPath !== 'python') {
      void vscode.window.showErrorMessage(`Python 解释器不存在: ${pythonPath}`);
      return;
    }
    this.currentTask = task;
    this.running = true;
    this.output.clear();
    this.output.appendLine(`▶ 启动任务: ${task.displayName} (${task.module})`);
    this.output.appendLine(`项目: ${projectDir}`);
    this.output.appendLine(`Python: ${pythonPath}`);
    this.output.show(true);
    void view.webview.postMessage({ type: 'running', task, running: true });

    const args = buildRunArgs(task.className, this.configModule);
    const child = cp.spawn(pythonPath, args, {
      cwd: projectDir,
      windowsHide: true,
      env: { ...process.env },
    });
    child.stdout?.on('data', (d) => this.output.append(d.toString()));
    child.stderr?.on('data', (d) => this.output.append(d.toString()));
    child.on('error', (err) => {
      this.running = false;
      this.output.appendLine('');
      this.output.appendLine(`❌ 无法启动 Python 进程: ${err.message}`);
      void vscode.window.showErrorMessage(`无法启动任务: ${err.message}`);
      void view.webview.postMessage({ type: 'running', task, running: false, error: err.message });
    });
    child.on('close', (code) => {
      this.running = false;
      this.output.appendLine('');
      this.output.appendLine(code === 0 ? '✅ 任务完成' : `❌ 任务退出码: ${code}`);
      void view.webview.postMessage({ type: 'running', task, running: false, code });
    });
  }

  /** 释放资源（output channel 由扩展生命周期统一关闭） */
  dispose(): void {
    this.output.dispose();
  }

  private buildHtml(): string {
    const nonce = Math.random().toString(36).slice(2, 14);
    return `<!DOCTYPE html>
<html lang="zh-cn">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'">
<style>
  body {
    color: var(--vscode-editor-foreground);
    background: var(--vscode-editor-background);
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size, 13px);
    margin: 0;
    padding: 10px 12px 20px;
  }
  .toolbar {
    display: flex;
    gap: 8px;
    align-items: center;
    margin-bottom: 8px;
  }
  button {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    padding: 4px 10px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .task {
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.25));
    border-radius: 6px;
    padding: 8px 10px;
    margin-bottom: 6px;
    background: var(--vscode-editorWidget-background, rgba(128,128,128,.06));
  }
  .task:hover { border-color: var(--vscode-focusBorder); }
  .task .name { font-weight: 600; margin-bottom: 2px; }
  .task .cls { opacity: .6; font-size: 11px; }
  .task .launch-btn {
    margin-top: 6px;
    width: 100%;
  }
  .task .launch-btn:disabled { opacity: .5; cursor: not-allowed; }
  .status { margin-top: 8px; padding: 6px 8px; border-radius: 4px; font-size: 12px; }
  .status.warn { background: var(--vscode-inputValidation-warningBackground, rgba(255,193,7,.15)); }
  .status.error { background: var(--vscode-inputValidation-errorBackground, rgba(255,0,0,.15)); }
  .status.ok { background: var(--vscode-inputValidation-infoBackground, rgba(0,122,204,.15)); }
  .empty { opacity: .6; text-align: center; margin-top: 32px; line-height: 1.8; }
</style>
</head>
<body>
  <div class="toolbar">
    <button id="refresh" class="secondary">↻ 刷新</button>
  </div>
  <div id="tasks"></div>
  <div id="status" class="status" style="display:none"></div>
  <div id="empty" class="empty" style="display:none">未找到任务。<br>请先在设置中配置项目路径。</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const tasksEl = document.getElementById('tasks');
  const statusEl = document.getElementById('status');
  const emptyEl = document.getElementById('empty');
  const refreshBtn = document.getElementById('refresh');
  let running = false;

  function setStatus(level, text) {
    if (!text) { statusEl.style.display = 'none'; return; }
    statusEl.style.display = '';
    statusEl.className = 'status ' + level;
    statusEl.textContent = text;
  }

  function render(tasks) {
    tasksEl.innerHTML = '';
    emptyEl.style.display = tasks.length ? 'none' : '';
    for (const t of tasks) {
      const card = document.createElement('div');
      card.className = 'task';
      const nm = document.createElement('div');
      nm.className = 'name';
      nm.textContent = t.displayName;
      nm.title = t.module;
      const cl = document.createElement('div');
      cl.className = 'cls';
      cl.textContent = t.className;
      const btn = document.createElement('button');
      btn.className = 'launch-btn';
      btn.textContent = '▶ 启动';
      btn.dataset.module = t.module;
      btn.dataset.cls = t.className;
      btn.dataset.name = t.displayName;
      btn.addEventListener('click', () => {
        if (running) return;
        vscode.postMessage({ type: 'launch', task: { module: t.module, className: t.className, displayName: t.displayName } });
      });
      card.appendChild(nm);
      card.appendChild(cl);
      card.appendChild(btn);
      tasksEl.appendChild(card);
    }
  }

  function setRunning(r) {
    running = r;
    for (const b of tasksEl.querySelectorAll('.launch-btn')) {
      b.disabled = r;
      b.textContent = r ? '⏳ 运行中…' : '▶ 启动';
    }
  }

  refreshBtn.addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
  window.addEventListener('message', (e) => {
    const msg = e.data;
    switch (msg.type) {
      case 'tasks': render(msg.tasks || []); break;
      case 'status': setStatus(msg.level, msg.text); break;
      case 'running': setRunning(msg.running); if (msg.running === false) setStatus('ok', '任务结束，详见输出面板'); break;
    }
  });
  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
  }
}
