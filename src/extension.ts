import * as path from 'path';
import * as vscode from 'vscode';
import { LangData, poDirectorySetting } from './langData';
import { FeatureData } from './featureData';
import { clearCropCache, clearThumbDir, warmCropCache } from './pngCrop';
import {
  LangCompletionProvider,
  LangHoverProvider,
  LangInlayHintsProvider,
} from './providers';
import {
  TemplateGalleryPanel,
  TemplateGalleryViewProvider,
  repaintAllGalleries,
} from './templatePanel';
import { TaskLauncherViewProvider } from './taskLauncher';

export function activate(context: vscode.ExtensionContext): void {
  const folder = vscode.workspace.workspaceFolders?.[0];
  const data = new LangData(folder);
  const features = new FeatureData(folder);
  const inlay = new LangInlayHintsProvider(data, features);
  // 模板缩略图 PNG 落盘目录（webview 经 asWebviewUri 加载）
  const thumbDir = path.join(context.globalStorageUri.fsPath, 'template-thumbs');

  // 后台预热：把全部模板缩略图裁进缓存，后续 hover/补全直接命中
  const prewarm = () => {
    const reqs = features.all().map((ft) => ({
      imagePath: ft.imagePath,
      bbox: ft.bbox,
    }));
    void warmCropCache(reqs);
  };

  // lang JSON / 模板标注 / 模板图片变化时刷新数据并重算幽灵注释
  // 防抖 300ms：批量保存（如图片重导出）只合并触发一次，避免反复清缓存+全量预热
  let refreshTimer: NodeJS.Timeout | undefined;
  const refresh = () => {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      data.refresh(true);
      features.refresh(true);
      clearCropCache();
      clearThumbDir(thumbDir); // 缩略图文件名是确定性的，图片变化后必须清掉旧文件
      prewarm();
      inlay.fire();
      repaintAllGalleries(); // 模板视图已打开时同步刷新
    }, 300);
  };

  /** 转义 glob 元字符（PO 目录可能含 . 等） */
  const escapeGlobSeg = (s: string) => s.replace(/([\\*?[\]{}()!])/g, '\\$1');

  /** 语言数据监听 glob：lang JSON + gettext PO + 模板数据 */
  const langWatchPattern = () => {
    const poDir = poDirectorySetting().replace(/[\\/]+$/, '');
    const poGlob = poDir.split(/[\\/]/).map(escapeGlobSeg).join('/');
    return `**/{assets/lang/*.json,${poGlob}/**/*.po,assets/coco_annotations.json,assets/images/*.png,ok_tasks/assets/coco_annotations.json,ok_tasks/assets/images/*.png}`;
  };

  let watcher: vscode.FileSystemWatcher | undefined;
  const recreateWatcher = () => {
    if (watcher) watcher.dispose();
    watcher = vscode.workspace.createFileSystemWatcher(langWatchPattern());
    watcher.onDidChange(refresh);
    watcher.onDidCreate(refresh);
    watcher.onDidDelete(refresh);
    return watcher;
  };
  context.subscriptions.push(recreateWatcher());

  const taskLauncher = new TaskLauncherViewProvider(context.extensionUri);
  context.subscriptions.push(taskLauncher);

  context.subscriptions.push(
    vscode.languages.registerInlayHintsProvider(
      { language: 'python', scheme: 'file' },
      inlay,
    ),
    vscode.languages.registerHoverProvider(
      { language: 'python', scheme: 'file' },
      new LangHoverProvider(data, features),
    ),
    vscode.languages.registerCompletionItemProvider(
      { language: 'python', scheme: 'file' },
      new LangCompletionProvider(data, features),
      '.', "'", '"',
    ),
    vscode.window.registerWebviewViewProvider(
      TemplateGalleryViewProvider.viewType,
      new TemplateGalleryViewProvider(features, thumbDir),
    ),
    vscode.window.registerWebviewViewProvider(
      TaskLauncherViewProvider.viewType,
      taskLauncher,
    ),
    vscode.commands.registerCommand('okLangHints.showTemplates', () => {
      // 聚焦活动栏中的模板视图（左侧图标 Tab）
      void vscode.commands.executeCommand(`${TemplateGalleryViewProvider.viewType}.focus`);
    }),
    vscode.commands.registerCommand('okLangHints.openTemplatesEditor', () => {
      TemplateGalleryPanel.show(features, thumbDir);
    }),
    vscode.commands.registerCommand('okLangHints.showTaskLauncher', () => {
      // 聚焦活动栏中的任务启动视图
      void vscode.commands.executeCommand(`${TaskLauncherViewProvider.viewType}.focus`);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('okLangHints')) {
        recreateWatcher();
        data.refresh(true);
        features.refresh(true);
        clearCropCache();
        clearThumbDir(thumbDir);
        prewarm();
        inlay.fire();
        repaintAllGalleries();
      }
    }),
  );

  // 首次激活：先加载数据，再后台预热缩略图缓存
  data.refresh(true);
  features.refresh(true);
  prewarm();
}

export function deactivate(): void {
  // nothing to do
}
