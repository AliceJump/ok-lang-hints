import * as vscode from 'vscode';
import { LangData } from './langData';
import { FeatureData } from './featureData';
import { clearCropCache, warmCropCache } from './pngCrop';
import {
  LangCompletionProvider,
  LangHoverProvider,
  LangInlayHintsProvider,
} from './providers';

export function activate(context: vscode.ExtensionContext): void {
  const folder = vscode.workspace.workspaceFolders?.[0];
  const data = new LangData(folder);
  const features = new FeatureData(folder);
  const inlay = new LangInlayHintsProvider(data, features);

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
      prewarm();
      inlay.fire();
    }, 300);
  };
  const watcher = vscode.workspace.createFileSystemWatcher(
    '**/{assets/lang/*.json,assets/coco_annotations.json,assets/images/*.png,ok_tasks/assets/coco_annotations.json,ok_tasks/assets/images/*.png}',
  );
  context.subscriptions.push(watcher);
  watcher.onDidChange(refresh);
  watcher.onDidCreate(refresh);
  watcher.onDidDelete(refresh);

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
      '.',
    ),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('okLangHints')) {
        data.refresh(true);
        features.refresh(true);
        clearCropCache();
        prewarm();
        inlay.fire();
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
