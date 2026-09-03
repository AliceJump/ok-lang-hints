import * as path from 'path';
import * as vscode from 'vscode';
import { LangData, poDirectorySetting } from './langData';
import { tr } from './localization';
import { FeatureData } from './featureData';
import { EffectData } from './effectData';
import { clearCropCache, clearThumbDir, warmCropCache } from './pngCrop';
import {
  LangCompletionProvider,
  LangHoverProvider,
  LangInlayHintsProvider,
} from './providers';
import { EffectCompletionProvider, EffectHoverProvider, EffectInlayHintsProvider } from './effectProvider';
import {
  TemplateGalleryPanel,
  TemplateGalleryViewProvider,
  repaintAllGalleries,
} from './templatePanel';
import { TaskLauncherViewProvider } from './taskLauncher';
import { CharacterManagerLauncherViewProvider, CharacterManagerPanel } from './characterPanel';
import { TemplateAssetData } from './templateAssetData';
import {
  TemplateAssetViewProvider,
  TemplateAssetPanel,
  repaintAllAssetGalleries,
} from './templateAssetPanel';

export function activate(context: vscode.ExtensionContext): void {
  const folder = vscode.workspace.workspaceFolders?.[0];
  const data = new LangData(folder);
  const features = new FeatureData(folder);
  const effects = new EffectData(folder);
  const inlay = new LangInlayHintsProvider(data, features, effects);
  const jsonInlay = new EffectInlayHintsProvider(effects);
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

  // ---- 各数据源独立防抖刷新（300ms） ----
  /** 哪些数据源需要刷新（由 getAffectedSources 判定） */
  type RefreshTarget = { lang: boolean; features: boolean; effects: boolean };

  const DEBOUNCE_MS = 300;

  // lang 数据：self.lang JSON / gettext PO → 刷新 LangData + 幽灵注释
  let langTimer: NodeJS.Timeout | undefined;
  const refreshLang = () => {
    if (langTimer) clearTimeout(langTimer);
    langTimer = setTimeout(() => {
      data.refresh(true);
      inlay.fire();
    }, DEBOUNCE_MS);
  };

  // 模板数据：coco_annotations.json / 图片 PNG → 刷新 FeatureData + 清缓存 + 预热 + 画廊
  let featTimer: NodeJS.Timeout | undefined;
  const refreshFeatures = () => {
    if (featTimer) clearTimeout(featTimer);
    featTimer = setTimeout(() => {
      features.refresh(true);
      clearCropCache();
      clearThumbDir(thumbDir);
      prewarm();
      repaintAllGalleries();
      CharacterManagerPanel.refreshCurrent();
    }, DEBOUNCE_MS);
  };

  // 效果 ID：effects.py → 刷新 EffectData + JSON 幽灵注释
  let effectTimer: NodeJS.Timeout | undefined;
  const refreshEffects = () => {
    if (effectTimer) clearTimeout(effectTimer);
    effectTimer = setTimeout(() => {
      effects.refresh(true);
      jsonInlay.fire();
    }, DEBOUNCE_MS);
  };

  /** 转义 glob 元字符（PO 目录可能含 . 等） */
  const escapeGlobSeg = (s: string) => s.replace(/([\\*?[\]{}()!])/g, '\\$1');

  /** 语言数据监听 glob：lang JSON + gettext PO + 模板数据 + 效果 ID */
  const langWatchPattern = () => {
    const poDir = poDirectorySetting().replace(/[\/]+$/, '');
    const poGlob = poDir.split(/[\\/]/).map(escapeGlobSeg).join('/');
    const effectsFile = (vscode.workspace.getConfiguration('okLangHints').get<string>('effectsFile') || 'src/data/effects.py')
      .replace(/[\\]+/g, '/')
      .replace(/^\//, '');
    return `**/{assets/lang/*.json,${poGlob}/**/*.po,assets/coco_annotations.json,assets/images/*.png,ok_tasks/assets/coco_annotations.json,ok_tasks/assets/images/*.png,${effectsFile}}`;
  };

  /**
   * 判定变更文件属于哪些数据源（lang / features / effects）。
   * createFileSystemWatcher 的字符串 glob 在嵌套路径 + brace 组合下可能把工作区
   * 任意文件变更都派发进来，因此这里按 URI 的相对路径二次过滤，避免每次保存任意
   * 代码都重载模板库。
   */
  const getAffectedSources = (uri: vscode.Uri): RefreshTarget => {
    const empty: RefreshTarget = { lang: false, features: false, effects: false };
    const wsFolder = vscode.workspace.getWorkspaceFolder(uri);
    const rel = (wsFolder ? path.relative(wsFolder.uri.fsPath, uri.fsPath) : uri.fsPath)
      .replace(/[\\/]+/g, '/')
      .replace(/^\/+/, '');
    if (!rel) return empty;

    const poDir = poDirectorySetting().replace(/[\\]+/g, '/').replace(/\/+$/, '');
    const effectsFile = (vscode.workspace.getConfiguration('okLangHints').get<string>('effectsFile') || 'src/data/effects.py')
      .replace(/[\\]+/g, '/')
      .replace(/^\//, '');

    if (rel.startsWith('assets/lang/') && rel.endsWith('.json')) {
      return { ...empty, lang: true };
    }
    if (rel.startsWith(`${poDir}/`) && rel.endsWith('.po')) {
      return { ...empty, lang: true };
    }
    const pngRe = /\.png$/i;
    if (
      rel === 'assets/coco_annotations.json' ||
      rel === 'ok_tasks/assets/coco_annotations.json' ||
      (rel.startsWith('assets/images/') && pngRe.test(rel)) ||
      (rel.startsWith('ok_tasks/assets/images/') && pngRe.test(rel))
    ) {
      return { ...empty, features: true };
    }
    if (rel === effectsFile) {
      return { ...empty, effects: true };
    }
    return empty;
  };

  const dispatchRefresh = (target: RefreshTarget) => {
    if (target.lang) refreshLang();
    if (target.features) refreshFeatures();
    if (target.effects) refreshEffects();
  };

  let watcher: vscode.FileSystemWatcher | undefined;
  const recreateWatcher = () => {
    if (watcher) watcher.dispose();
    watcher = vscode.workspace.createFileSystemWatcher(langWatchPattern());
    watcher.onDidChange((uri) => dispatchRefresh(getAffectedSources(uri)));
    watcher.onDidCreate((uri) => dispatchRefresh(getAffectedSources(uri)));
    watcher.onDidDelete((uri) => dispatchRefresh(getAffectedSources(uri)));
    return watcher;
  };
  recreateWatcher();
  context.subscriptions.push({
    dispose: () => {
      watcher?.dispose();
      watcher = undefined;
      if (langTimer) clearTimeout(langTimer);
      if (featTimer) clearTimeout(featTimer);
      if (effectTimer) clearTimeout(effectTimer);
    },
  });

  const taskLauncher = new TaskLauncherViewProvider(context.extensionUri);
  const characterManagerDependencies = {
    extensionUri: context.extensionUri,
    features,
    thumbDir,
  };

  // 模板素材数据管理
  const templateAssetData = new TemplateAssetData(folder);
  context.subscriptions.push(taskLauncher);

  context.subscriptions.push(
    vscode.languages.registerInlayHintsProvider(
      { language: 'python', scheme: 'file' },
      inlay,
    ),
    vscode.languages.registerHoverProvider(
      { language: 'python', scheme: 'file' },
      new LangHoverProvider(data, features, effects),
    ),
    vscode.languages.registerCompletionItemProvider(
      { language: 'python', scheme: 'file' },
      new LangCompletionProvider(data, features, effects),
      '.', "'", '"',
    ),
    // 效果 ID 提示：JSON / JSONC 数据文件（character_skills/*.json 等）中的
    // "effect_id": "XXX" hover 显示分类与描述，引号内补全效果 ID。
    vscode.languages.registerHoverProvider(
      { language: 'json', scheme: 'file' },
      new EffectHoverProvider(effects),
    ),
    vscode.languages.registerHoverProvider(
      { language: 'jsonc', scheme: 'file' },
      new EffectHoverProvider(effects),
    ),
    vscode.languages.registerCompletionItemProvider(
      { language: 'json', scheme: 'file' },
      new EffectCompletionProvider(effects),
      '"',
    ),
    vscode.languages.registerCompletionItemProvider(
      { language: 'jsonc', scheme: 'file' },
      new EffectCompletionProvider(effects),
      '"',
    ),
    // 效果 ID 幽灵注释：JSON / JSONC 中 "effect_id": "XXX" 后行内显示中文描述
    vscode.languages.registerInlayHintsProvider(
      { language: 'json', scheme: 'file' },
      jsonInlay,
    ),
    vscode.languages.registerInlayHintsProvider(
      { language: 'jsonc', scheme: 'file' },
      jsonInlay,
    ),
    vscode.window.registerWebviewViewProvider(
      TemplateGalleryViewProvider.viewType,
      new TemplateGalleryViewProvider(context.extensionUri, features, thumbDir),
    ),
    vscode.window.registerWebviewViewProvider(
      TaskLauncherViewProvider.viewType,
      taskLauncher,
    ),
    vscode.window.registerWebviewViewProvider(
      CharacterManagerLauncherViewProvider.viewType,
      new CharacterManagerLauncherViewProvider(characterManagerDependencies),
    ),
    vscode.window.registerWebviewViewProvider(
      TemplateAssetViewProvider.viewType,
      new TemplateAssetViewProvider(templateAssetData, thumbDir, context.extensionUri),
    ),
    vscode.commands.registerCommand('okLangHints.showTemplates', () => {
      // 聚焦活动栏中的模板视图（左侧图标 Tab）
      void vscode.commands.executeCommand(`${TemplateGalleryViewProvider.viewType}.focus`);
    }),
    vscode.commands.registerCommand('okLangHints.openTemplatesEditor', () => {
      TemplateGalleryPanel.show(features, thumbDir, context.extensionUri);
    }),
    vscode.commands.registerCommand('okLangHints.showTaskLauncher', () => {
      // 聚焦活动栏中的任务启动视图
      void vscode.commands.executeCommand(`${TaskLauncherViewProvider.viewType}.focus`);
    }),
    vscode.commands.registerCommand('okLangHints.openCharacterManager', () => {
      CharacterManagerPanel.show(characterManagerDependencies);
    }),
    vscode.commands.registerCommand('okLangHints.openTemplateAssets', () => {
      TemplateAssetPanel.show(templateAssetData, thumbDir, context.extensionUri);
    }),
    vscode.commands.registerCommand('okLangHints.openAnnotationEditor', () => {
      // 打开当前选中的图片，或者提示用户先选择
      void vscode.window.showInformationMessage(tr('Please click an image in the Template Assets panel to open the annotation editor.'));
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('okLangHints')) {
        recreateWatcher();
        data.refresh(true);
        features.refresh(true);
        effects.refresh(true);
        clearCropCache();
        clearThumbDir(thumbDir);
        prewarm();
        inlay.fire();
        jsonInlay.fire();
        repaintAllGalleries();
        CharacterManagerPanel.refreshCurrent();
      }
    }),
  );

  // 首次激活：先加载数据，再后台预热缩略图缓存
  data.refresh(true);
  features.refresh(true);
  effects.refresh(true);
  prewarm();
}

export function deactivate(): void {
  // nothing to do
}
