import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { injectWebviewLocalization, projectLocale, tr } from './localization';

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

/** 每个任务可编辑的一项参数（对应项目任务 default_config 里的一个 key） */
interface TaskParamField {
  key: string;
  displayKey?: string;
  /** 默认值（决定控件类型：bool→开关、int/float→数字、str→文本框、list→多选/列表） */
  default?: unknown;
  /** 当前已保存值 */
  value?: unknown;
  /** config_type 元信息（drop_down / multi_selection 的 options 等） */
  type?: Record<string, unknown>;
  /** config_description 说明 */
  desc?: string;
  displayDesc?: string;
}

/** 从项目任务类采集到的 schema */
interface TaskSchema {
  /** 该任务可编辑的参数列表（按 default_config 顺序） */
  fields: TaskParamField[];
  /** 是否采集失败（broken） */
  broken?: boolean;
  error?: string;
  displayName?: string;
  description?: string;
  kind?: 'onetime' | 'trigger';
  /** 项目声明的配置分组/子任务树：组名 -> 字段或子组 key。 */
  configGroups?: Record<string, string[]>;
  groupLabels?: Record<string, string>;
  /** register_config_groups 生成的分组下拉字段。 */
  groupSelector?: string;
  locale?: string;
}

/** 每个任务的独立配置（持久化到 .vscode/ok-lang-hints-tasks.json） */
interface TaskConfig {
  /** 透传给 ok-script / 项目级 argparse 的额外命令行参数。 */
  extraArgs?: string;
  /** 仅对当前任务子进程生效的环境变量。 */
  env?: Record<string, string>;
  /** 自动停止超时（秒）；0 或未设置表示不限时。 */
  timeout?: number;
  /** 任务参数覆盖：key=任务 default_config 的 key，value=覆盖值 */
  params?: Record<string, unknown>;
}

/** 所有任务配置的持久化结构 */
interface TaskConfigStore {
  projects: Record<string, { tasks: Record<string, TaskConfig> }>;
}

/** schema 采集结果（刷新时全量 import 项目任务后落盘缓存） */
interface SchemaProbeResult {
  ok: boolean;
  error?: string;
  schemas?: Record<string, TaskSchema>;
  /** 参与采集的任务总数 */
  total?: number;
}

/** 扩展根目录下 python/ 脚本的绝对路径 */
function pythonScript(extensionUri: vscode.Uri, name: string): string {
  return path.join(extensionUri.fsPath, 'python', name);
}

/** 解析 Python 子进程 stdout 中最后一个 JSON 行（前面的输出可能是日志） */
function parseJsonFromStdout(stdout: string): any {
  const lines = stdout.split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]);
    } catch { /* 跳过非 JSON 行 */ }
  }
  return null;
}

/** 解析额外参数：优先接受 JSON 字符串数组，否则按 shell 风格引号拆分。 */
function parseExtraArgs(value: string | undefined): string[] {
  const text = value?.trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
      return parsed;
    }
  } catch { /* 回退到引号拆分 */ }

  const args: string[] = [];
  let current = '';
  let quote: '"' | "'" | '' = '';
  let escaped = false;
  for (const char of text) {
    if (escaped) {
      current += char;
      escaped = false;
    } else if (char === '\\') {
      escaped = true;
    } else if (quote) {
      if (char === quote) quote = '';
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = '';
      }
    } else {
      current += char;
    }
  }
  if (escaped) current += '\\';
  if (quote) throw new Error(tr('Extra arguments contain an unclosed quote'));
  if (current) args.push(current);
  return args;
}

interface PythonResult {
  stdout: string;
  stderr: string;
}

/** 异步运行 Python，避免耗时探针阻塞 VS Code 扩展宿主。 */
function runPython(
  pythonPath: string,
  args: string[],
  projectDir: string,
  timeout: number,
): Promise<PythonResult> {
  const env = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
  return new Promise((resolve, reject) => {
    cp.execFile(pythonPath, args, {
      cwd: projectDir,
      env,
      encoding: 'utf-8',
      timeout,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr?.trim() || error.message));
        return;
      }
      resolve({ stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

/**
 * 用 Python 子进程 + AST 安全解析 ok-script 项目的 src/config.py，
 * 提取 onetime_tasks / trigger_tasks 注册表，不导入任何模块。
 */
async function parseConfigTasks(extensionUri: vscode.Uri, projectDir: string, pythonPath: string): Promise<TaskListResult> {
  try {
    const result = await runPython(
      pythonPath,
      [pythonScript(extensionUri, 'parse_config_tasks.py'), projectDir],
      projectDir,
      15000,
    );
    const parsed = parseJsonFromStdout(result.stdout || '');
    if (!parsed || !parsed.ok) {
      return { ok: false, error: parsed?.error || tr('Failed to parse task list') };
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

/**
 * 运行单个任务（headless，不启动 GUI）——spawn python/run_task.py。
 *
 * 参数覆盖经环境变量 OK_LANG_HINTS_INJECT 传入：{"module::TaskClassName": {key: value}}。
 * run_task.py 内猴子补丁 BaseTask.load_config，在任务加载配置后把 params 覆盖进
 * self.config（仅内存，不写 configs/*.json，不污染项目配置）。
 */
function buildRunTaskCommand(extensionUri: vscode.Uri, task: TaskInfo, configModule: string): string[] {
  return [
    pythonScript(extensionUri, 'run_task.py'),
    '--task', task.className,
    '--task-module', task.module,
    '--config-module', configModule,
  ];
}

/**
 * 用 Python 子进程 + 全量 import 采集项目所有任务的配置 schema —— spawn
 * python/probe_task_schemas.py。复用 ok-script 的 OK(config) + TaskManager
 * 初始化来实例化任务，拿到经过继承链合并的真实 default_config / config_type /
 * config_description / 已保存 config。逐任务 try/except 容错，坏任务标记 broken。
 */
async function probeTaskSchemas(
  extensionUri: vscode.Uri,
  projectDir: string,
  pythonPath: string,
  locale: string,
  poDirectory: string,
): Promise<SchemaProbeResult> {
  try {
    const result = await runPython(
      pythonPath,
      [pythonScript(extensionUri, 'probe_task_schemas.py'), projectDir, locale, poDirectory],
      projectDir,
      120000,
    );
    const parsed = parseJsonFromStdout(result.stdout || '');
    if (!parsed || !parsed.ok) {
      return { ok: false, error: parsed?.error || tr('Failed to collect task schema') };
    }
    return { ok: true, schemas: parsed.schemas, total: parsed.total };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 侧边栏任务启动视图 */
export class TaskLauncherViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'okScriptToolkit.taskLauncher';

  private readonly output: vscode.OutputChannel;
  private running = false;
  private currentTask: TaskInfo | undefined;
  private configModule = 'src.config';
  private childProcess: cp.ChildProcess | null = null;
  private stopRequested = false;
  private timedOutRequested = false;
  private timeoutTimer: NodeJS.Timeout | undefined;
  private view: vscode.WebviewView | null = null;
  private currentProjectDir = '';
  private refreshGeneration = 0;
  /** 每任务独立配置（内存缓存 + 持久化到 .vscode/ok-lang-hints-tasks.json） */
  private taskConfigs: Record<string, TaskConfig> = {};
  private knownTasks: TaskInfo[] = [];
  /** 采集到的任务参数 schema（缓存到 .vscode/ok-lang-hints-schema.json） */
  private schemas: Record<string, TaskSchema> = {};

  constructor(
    private readonly extensionUri: vscode.Uri,
  ) {
    this.output = vscode.window.createOutputChannel(tr('ok-script Task Launcher'));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media', 'taskLauncher')],
    };
    view.webview.html = this.buildHtml(view.webview);

    view.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'ready':
          await this.refreshTasks(view);
          // webview 重建后同步当前运行状态，避免切换侧边栏再回来时按钮状态丢失
          if (this.running && this.currentTask) {
            void view.webview.postMessage({ type: 'running', task: this.currentTask, running: true });
          }
          break;
        case 'refresh':
          await this.refreshTasks(view);
          break;
        case 'launch':
          if (this.isKnownTask(msg.task)) await this.launchTask(view, msg.task);
          break;
        case 'stop':
          await this.stopTask();
          break;
        case 'saveConfig':
          if (this.isKnownTask(msg.task)) await this.saveTaskConfig(msg.task, this.sanitizeTaskConfig(msg.task, msg.config));
          break;
        case 'loadConfigs':
          await this.loadTaskConfigs();
          break;
      }
    });
  }

  private isKnownTask(task: unknown): task is TaskInfo {
    if (!task || typeof task !== 'object') return false;
    const candidate = task as Partial<TaskInfo>;
    if (typeof candidate.module !== 'string' || typeof candidate.className !== 'string') return false;
    return this.knownTasks.some((task) => task.module === candidate.module && task.className === candidate.className);
  }

  private sanitizeTaskConfig(task: TaskInfo, value: unknown): TaskConfig {
    if (!value || typeof value !== 'object') return {};
    const raw = value as Record<string, unknown>;
    const config: TaskConfig = {};
    if (typeof raw.extraArgs === 'string' && raw.extraArgs.trim()) config.extraArgs = raw.extraArgs.trim();
    if (typeof raw.timeout === 'number' && Number.isFinite(raw.timeout) && raw.timeout > 0) {
      config.timeout = Math.min(raw.timeout, 7 * 24 * 60 * 60);
    }
    if (raw.env && typeof raw.env === 'object' && !Array.isArray(raw.env)) {
      const env: Record<string, string> = {};
      for (const [key, item] of Object.entries(raw.env as Record<string, unknown>)) {
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof item === 'string') env[key] = item;
      }
      if (Object.keys(env).length) config.env = env;
    }
    if (raw.params && typeof raw.params === 'object' && !Array.isArray(raw.params)) {
      const allowed = new Set((this.schemas[this.taskKey(task)]?.fields || []).map((field) => field.key));
      const params: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(raw.params as Record<string, unknown>)) {
        if (allowed.has(key)) params[key] = item;
      }
      if (Object.keys(params).length) config.params = params;
    }
    return config;
  }

  /** .vscode 目录下 ok-lang-hints 数据文件的绝对路径 */
  private dataFile(name: string): string {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    return path.join(root, '.vscode', name);
  }

  /** 读取 .vscode/ok-lang-hints-tasks.json（每任务独立配置持久化） */
  private loadTaskConfigs(projectDir = this.currentProjectDir): void {
    try {
      const p = this.dataFile('ok-lang-hints-tasks.json');
      if (fs.existsSync(p)) {
        const raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as Partial<TaskConfigStore> & { tasks?: Record<string, TaskConfig> };
        // 兼容旧版顶层 tasks 格式；保存后自动迁移为按项目隔离的 projects。
        this.taskConfigs = raw.projects?.[projectDir]?.tasks || raw.tasks || {};
      } else {
        this.taskConfigs = {};
      }
    } catch (e) {
      this.taskConfigs = {};
      void vscode.window.showWarningMessage(tr('Failed to read task configuration: {error}', {
        error: e instanceof Error ? e.message : String(e),
      }));
    }
    if (this.view) {
      void this.view.webview.postMessage({ type: 'taskConfigs', configs: this.taskConfigs });
    }
  }

  /** 保存单个任务的配置到 .vscode/ok-lang-hints-tasks.json */
  private async saveTaskConfig(task: TaskInfo, config: TaskConfig): Promise<void> {
    const key = `${task.module}::${task.className}`;
    const nextConfigs = { ...this.taskConfigs, [key]: config };
    try {
      const p = this.dataFile('ok-lang-hints-tasks.json');
      fs.mkdirSync(path.dirname(p), { recursive: true });
      let store: TaskConfigStore = { projects: {} };
      if (fs.existsSync(p)) {
        const raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as Partial<TaskConfigStore>;
        if (raw.projects && typeof raw.projects === 'object') {
          store = { projects: raw.projects };
        }
      }
      store.projects[this.currentProjectDir] = { tasks: nextConfigs };
      fs.writeFileSync(p, JSON.stringify(store, null, 2), 'utf-8');
    } catch (e) {
      const message = tr('Failed to save task configuration: {error}', {
        error: e instanceof Error ? e.message : String(e),
      });
      void vscode.window.showErrorMessage(message);
      if (this.view) {
        void this.view.webview.postMessage({ type: 'status', level: 'error', text: message });
      }
      return;
    }
    this.taskConfigs = nextConfigs;
    if (this.view) {
      void this.view.webview.postMessage({ type: 'taskConfigs', configs: this.taskConfigs });
      void this.view.webview.postMessage({
        type: 'status',
        level: 'ok',
        text: tr('Saved parameters for {task}', {
          task: this.schemas[this.taskKey(task)]?.displayName || task.displayName,
        }),
      });
    }
  }

  /** 读取 schema 缓存；无缓存时返回空 */
  private loadSchemaCache(projectDir: string, locale: string): Record<string, TaskSchema> {
    try {
      const p = this.dataFile('ok-lang-hints-schema.json');
      if (fs.existsSync(p)) {
        const raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as SchemaProbeResult & { projectDir?: string; locale?: string };
        const cachedLocale = raw.locale || Object.values(raw.schemas || {})[0]?.locale;
        return raw.projectDir === projectDir && cachedLocale === locale ? raw.schemas || {} : {};
      }
    } catch { /* 忽略损坏的缓存 */ }
    return {};
  }

  /** 写入 schema 缓存 */
  private saveSchemaCache(projectDir: string, locale: string, schemas: Record<string, TaskSchema>): void {
    try {
      const p = this.dataFile('ok-lang-hints-schema.json');
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify({ ok: true, projectDir, locale, schemas }, null, 2), 'utf-8');
    } catch { /* 缓存失败不阻塞 */ }
  }

  /**
   * 读取配置获取项目路径和 Python 解释器。
   * 配置未填写时，自动检测当前工作区根目录（若含 src/config.py 则视为 ok-script 项目）。
   */
  private getConfig(): { projectDir: string; pythonPath: string; fromConfig: boolean } {
    const cfg = vscode.workspace.getConfiguration('okScriptToolkit');
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
    const generation = ++this.refreshGeneration;
    this.knownTasks = [];
    const { projectDir, pythonPath, fromConfig } = this.getConfig();
    const locale = projectLocale();
    if (!projectDir) {
      void view.webview.postMessage({ type: 'tasks', tasks: [], schemas: {} });
      void view.webview.postMessage({
        type: 'status',
        level: 'warn',
        text: tr('No ok-script project was found. Configure okScriptToolkit.okScriptProjectPath or open a folder containing src/config.py.'),
      });
      return;
    }
    if (!fs.existsSync(projectDir)) {
      void view.webview.postMessage({ type: 'tasks', tasks: [], schemas: {} });
      void view.webview.postMessage({
        type: 'status',
        level: 'warn',
        text: tr('Project directory does not exist: {path}', { path: projectDir }),
      });
      return;
    }
    // 先读缓存（可能有上次采集的 schema，先让 UI 能用）
    this.currentProjectDir = projectDir;
    this.schemas = this.loadSchemaCache(projectDir, locale);
    this.loadTaskConfigs(projectDir);
    const result = await parseConfigTasks(this.extensionUri, projectDir, pythonPath);
    if (generation !== this.refreshGeneration) return;
    if (!result.ok) {
      void view.webview.postMessage({ type: 'tasks', tasks: [], schemas: {} });
      void view.webview.postMessage({
        type: 'status',
        level: 'error',
        text: tr('Failed to load task list: {error}', { error: result.error || tr('Unknown error') }),
      });
      return;
    }
    if (result.configModule) this.configModule = result.configModule;
    const tasks = (result.tasks || []).map((task) => ({
      ...task,
      displayName: this.schemas[this.taskKey(task)]?.displayName || task.displayName,
    }));
    this.knownTasks = tasks;
    await view.webview.postMessage({ type: 'tasks', tasks, schemas: this.schemas });
    void view.webview.postMessage({
      type: 'status',
      level: 'ok',
      text: fromConfig
        ? tr('Loaded {count} tasks', { count: tasks.length })
        : tr('Workspace project detected · Loaded {count} tasks', { count: tasks.length }),
    });

    // 后台全量 import 采集 schema（失败不影响任务列表，仅提示）
    void this.probeSchemasInBackground(view, projectDir, pythonPath, locale, generation);
  }

  /** 后台采集任务参数 schema：全量 import 项目任务，成功则缓存并回推给 UI */
  private async probeSchemasInBackground(
    view: vscode.WebviewView,
    projectDir: string,
    pythonPath: string,
    locale: string,
    generation: number,
  ): Promise<void> {
    const poDirectory = vscode.workspace.getConfiguration('okScriptToolkit').get<string>('poDirectory') || 'i18n';
    const probe = await probeTaskSchemas(
      this.extensionUri,
      projectDir,
      pythonPath,
      locale,
      poDirectory,
    );
    if (generation !== this.refreshGeneration || projectDir !== this.currentProjectDir) return;
    if (!probe.ok || !probe.schemas) {
      void view.webview.postMessage({
        type: 'status',
        level: 'warn',
        text: tr('Failed to collect task parameter schema (launch is still available): {error}', {
          error: probe.error || tr('Unknown error'),
        }),
      });
      return;
    }
    this.schemas = probe.schemas;
    this.saveSchemaCache(projectDir, locale, probe.schemas);
    const brokenCount = Object.values(probe.schemas).filter((s) => s.broken).length;
    // 只回推 schema 更新，让 UI 把已展开的任务卡片渲染出参数表单
    void view.webview.postMessage({ type: 'schemas', schemas: this.schemas });
    if (!this.running) {
      void view.webview.postMessage({
        type: 'status',
        level: 'ok',
        text: brokenCount
          ? tr('Loaded {count} tasks; parameter schema is ready ({broken} failed)', {
              count: probe.total ?? 0,
              broken: brokenCount,
            })
          : tr('Loaded {count} tasks; parameter schema is ready', { count: probe.total ?? 0 }),
      });
    }
  }

  private async launchTask(view: vscode.WebviewView, task: TaskInfo): Promise<void> {
    if (this.running) {
      void vscode.window.showWarningMessage(tr('A task is already running. Wait for it to finish or stop it first.'));
      return;
    }
    const { projectDir, pythonPath } = this.getConfig();
    if (!projectDir) {
      void vscode.window.showErrorMessage(tr('The ok-script project path is not configured.'));
      return;
    }
    if (!fs.existsSync(projectDir)) {
      void vscode.window.showErrorMessage(tr('Project directory does not exist: {path}', { path: projectDir }));
      return;
    }
    if (!fs.existsSync(pythonPath) && pythonPath !== 'python') {
      void vscode.window.showErrorMessage(tr('Python interpreter does not exist: {path}', { path: pythonPath }));
      return;
    }
    this.currentTask = task;
    this.running = true;
    this.stopRequested = false;
    this.timedOutRequested = false;
    this.output.clear();
    this.output.appendLine(tr('▶ Launch task: {task} ({module})', { task: task.displayName, module: task.module }));
    this.output.appendLine(tr('Project: {path}', { path: projectDir }));
    this.output.appendLine(tr('Python: {path}', { path: pythonPath }));
    // 带出该任务的独立配置（params 参数覆盖注入运行时）
    const cfg = this.getTaskConfig(task);
    if (cfg?.params && Object.keys(cfg.params).length > 0) {
      this.output.appendLine(tr('Parameter overrides: {count}', { count: Object.keys(cfg.params).length }));
    }
    this.output.show(true);
    void view.webview.postMessage({ type: 'running', task, running: true });

    let extraArgs: string[];
    try {
      extraArgs = parseExtraArgs(cfg.extraArgs);
    } catch (e) {
      this.running = false;
      const message = e instanceof Error ? e.message : String(e);
      void vscode.window.showErrorMessage(tr('Failed to launch task: {error}', { error: message }));
      void view.webview.postMessage({ type: 'running', task, running: false, error: message });
      return;
    }
    const args = [...buildRunTaskCommand(this.extensionUri, task, this.configModule), '--', ...extraArgs];
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
      ...(cfg.env || {}),
    };
    // 参数注入通过环境变量传递（避免命令行长度/转义问题）
    if (cfg?.params && Object.keys(cfg.params).length > 0) {
      childEnv.OK_LANG_HINTS_INJECT = JSON.stringify({ [this.taskKey(task)]: cfg.params });
    }
    this.childProcess = cp.spawn(pythonPath, args, {
      cwd: projectDir,
      windowsHide: true,
      // 强制子进程以 UTF-8 编码输出，与 Python 端 reconfigure 配合彻底解决乱码
      env: childEnv,
    });
    this.childProcess.stdout?.on('data', (d) => this.output.append(d.toString('utf8')));
    this.childProcess.stderr?.on('data', (d) => this.output.append(d.toString('utf8')));
    this.childProcess.on('error', (err) => {
      this.clearTimeoutTimer();
      this.running = false;
      this.childProcess = null;
      this.output.appendLine('');
      this.output.appendLine(tr('❌ Failed to start Python process: {error}', { error: err.message }));
      void vscode.window.showErrorMessage(tr('Failed to launch task: {error}', { error: err.message }));
      void view.webview.postMessage({ type: 'running', task, running: false, error: err.message });
    });
    this.childProcess.on('close', (code) => {
      this.clearTimeoutTimer();
      const stopped = this.stopRequested;
      const timedOut = this.timedOutRequested;
      this.running = false;
      this.childProcess = null;
      this.output.appendLine('');
      this.output.appendLine(stopped
        ? tr('⏹ Task stopped')
        : code === 0
          ? tr('✅ Task completed')
          : tr('❌ Task exit code: {code}', { code: code ?? 'null' }));
      void view.webview.postMessage({
        type: 'running',
        task,
        running: false,
        code,
        stopped,
        timedOut,
        error: !stopped && code !== 0 ? tr('Task exit code: {code}', { code: code ?? 'null' }) : undefined,
      });
    });
    if (cfg.timeout && cfg.timeout > 0) {
      const timeoutSeconds = cfg.timeout;
      this.timeoutTimer = setTimeout(() => {
        if (this.running && this.childProcess) {
          this.output.appendLine('');
          this.output.appendLine(tr('⏱ Timeout reached after {seconds} seconds; stopping task...', {
            seconds: timeoutSeconds,
          }));
          void this.stopTask(true);
        }
      }, timeoutSeconds * 1000);
    }
  }

  /** 读取某任务的独立配置（无则返回默认空配置） */
  private getTaskConfig(task: TaskInfo): TaskConfig {
    return this.taskConfigs[this.taskKey(task)] || {};
  }

  private taskKey(task: TaskInfo): string {
    return `${task.module}::${task.className}`;
  }

  private async stopTask(timedOut = false): Promise<void> {
    if (!this.running || !this.childProcess || !this.view) {
      void vscode.window.showWarningMessage(tr('No task is currently running.'));
      return;
    }
    
    this.output.appendLine('');
    this.output.appendLine(timedOut ? tr('⏱ Stopping timed-out task...') : tr('⏹ Stopping task...'));
    this.stopRequested = true;
    this.timedOutRequested = timedOut;
    void this.view.webview.postMessage({ type: 'running', task: this.currentTask, running: true, stopping: true, timedOut });
    
    // 尝试优雅终止
    try {
      if (process.platform === 'win32') {
        // Windows: 使用 taskkill
        const pid = this.childProcess.pid;
        if (!pid) {
          throw new Error(tr('Unable to get the process PID'));
        }
        const taskkill = cp.spawnSync('taskkill', ['/F', '/T', '/PID', pid.toString()], {
          windowsHide: true,
          env: process.env
        });
        if (taskkill.error) {
          throw taskkill.error;
        }
        if (taskkill.status !== 0) {
          throw new Error(taskkill.stderr?.toString().trim() || tr('taskkill exit code {code}', {
            code: taskkill.status ?? 'null',
          }));
        }
      } else {
        // Unix-like: 发送 SIGTERM
        this.childProcess.kill('SIGTERM');
      }
    } catch (err) {
      this.stopRequested = false;
      this.timedOutRequested = false;
      const error = err instanceof Error ? err.message : String(err);
      this.output.appendLine(tr('❌ Failed to stop task: {error}', { error }));
      void vscode.window.showErrorMessage(tr('Failed to stop task: {error}', { error }));
      void this.view.webview.postMessage({
        type: 'running',
        task: this.currentTask,
        running: true,
        error: tr('Failed to stop: {error}', { error }),
      });
    }
  }

  /** 释放资源（output channel 由扩展生命周期统一关闭） */
  dispose(): void {
    this.clearTimeoutTimer();
    if (this.childProcess) {
      this.childProcess.kill();
      this.childProcess = null;
    }
    this.output.dispose();
  }

  private clearTimeoutTimer(): void {
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = undefined;
    }
  }

  /** 读取任务启动器 Webview 外壳并注入 CSP 与本地资源 URI。 */
  private buildHtml(webview: vscode.Webview): string {
    const nonce = Math.random().toString(36).slice(2, 14);
    const htmlPath = path.join(this.extensionUri.fsPath, 'media', 'taskLauncher', 'index.html');
    let html = '';
    try {
      html = fs.readFileSync(htmlPath, 'utf-8');
    } catch (e) {
      return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${tr('Error')}</title></head><body style="font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:16px">${tr('Unable to read view file: {error}', { error: e instanceof Error ? e.message : String(e) })}</body></html>`;
    }
    const resource = (name: string) => webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'taskLauncher', name),
    ).toString(true);
    return injectWebviewLocalization(
      html
        .split('__CSP_NONCE__').join(nonce)
        .split('__CSP_SOURCE__').join(webview.cspSource)
        .split('__STYLE_URI__').join(resource('taskLauncher.css'))
        .split('__CORE_SCRIPT_URI__').join(resource('core.js'))
        .split('__FIELDS_SCRIPT_URI__').join(resource('fields.js'))
        .split('__CONFIG_PANEL_SCRIPT_URI__').join(resource('configPanel.js'))
        .split('__TASK_CARD_SCRIPT_URI__').join(resource('taskCard.js'))
        .split('__APP_SCRIPT_URI__').join(resource('app.js')),
    );
  }
}