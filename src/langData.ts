import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/** lang JSON 中的语言节点：{ "string": "..." } 或 { "pattern": "..." } */
export interface LangNode {
  string?: string;
  pattern?: string;
}

/** key -> { locale -> 节点 } */
export type ModuleDict = Record<string, Record<string, LangNode>>;

/** 一个 lang 条目：self.lang.<module>.<key> */
export interface LangEntry {
  module: string;
  key: string;
  locales: Record<string, LangNode>;
}

export const LOCALE_ORDER = ['zh_CN', 'zh_TW', 'en_US', 'ja_JP', 'ko_KR', 'es_ES'];

/** 将 VS Code UI 语言（如 zh-cn、ja）映射到项目 locale（如 zh_CN、ja_JP） */
export function normalizeLocale(uiLang: string): string {
  const map: Record<string, string> = {
    'zh-cn': 'zh_CN', 'zh-hans': 'zh_CN', 'zh': 'zh_CN',
    'zh-tw': 'zh_TW', 'zh-hant': 'zh_TW',
    'en': 'en_US',
    'ja': 'ja_JP',
    'ko': 'ko_KR',
    'es': 'es_ES',
  };
  return map[uiLang.toLowerCase()] || 'zh_CN';
}

/** 取节点的 string/pattern 值 */
export function nodeValue(node: LangNode | undefined): string | undefined {
  if (!node) return undefined;
  if (typeof node.string === 'string') return node.string;
  if (typeof node.pattern === 'string') return node.pattern;
  return undefined;
}

/** 返回节点类型：'string' | 'pattern' | undefined（string 优先） */
export function nodeType(node: LangNode | undefined): 'string' | 'pattern' | undefined {
  if (!node) return undefined;
  if (typeof node.string === 'string') return 'string';
  if (typeof node.pattern === 'string') return 'pattern';
  return undefined;
}

/** 取某语言的值与节点类型，缺失时回退 zh_CN，再回退第一个可用语言 */
export function pickEntry(
  entry: LangEntry,
  locale: string,
): { value?: string; type?: 'string' | 'pattern' } {
  const direct = entry.locales[locale];
  const directVal = nodeValue(direct);
  if (directVal !== undefined) return { value: directVal, type: nodeType(direct) };
  const fb = entry.locales['zh_CN'];
  const fbVal = nodeValue(fb);
  if (fbVal !== undefined) return { value: fbVal, type: nodeType(fb) };
  for (const l of LOCALE_ORDER) {
    const node = entry.locales[l];
    const v = nodeValue(node);
    if (v !== undefined) return { value: v, type: nodeType(node) };
  }
  return {};
}

/** 取某语言的值（仅值，兼容旧调用） */
export function pickValue(entry: LangEntry, locale: string): string | undefined {
  return pickEntry(entry, locale).value;
}

/** 加载 assets/lang/*.json 并缓存（按 mtime 增量刷新） */
export class LangData {
  private rootDir: string;
  private cache = new Map<string, ModuleDict>();
  private mtimes = new Map<string, number>();
  private knownModules = new Set<string>();

  constructor(root: vscode.WorkspaceFolder | undefined) {
    this.rootDir = root ? root.uri.fsPath : '';
  }

  private langDir(): string {
    const rel = vscode.workspace.getConfiguration('okLangHints').get<string>('langDirectory') || 'assets/lang';
    return path.join(this.rootDir, rel);
  }

  /** 强制全量刷新（删除已消失模块的缓存） */
  refresh(force = false): void {
    const dir = this.langDir();
    if (!this.rootDir || !fs.existsSync(dir)) return;

    const seen = new Set<string>();
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const fp = path.join(dir, f);
      const moduleName = f.replace(/\.json$/, '');
      seen.add(moduleName);
      try {
        const stat = fs.statSync(fp);
        const m = stat.mtimeMs;
        if (force || this.mtimes.get(fp) !== m) {
          this.mtimes.set(fp, m);
          const raw = JSON.parse(fs.readFileSync(fp, 'utf-8'));
          this.cache.set(moduleName, raw as ModuleDict);
          this.knownModules.add(moduleName);
        }
      } catch {
        // 跳过坏文件
      }
    }
    // 删除已消失的模块
    for (const mod of [...this.knownModules]) {
      if (!seen.has(mod)) {
        this.knownModules.delete(mod);
        this.cache.delete(mod);
      }
    }
  }

  modules(): string[] {
    this.refresh();
    return [...this.knownModules].sort();
  }

  keys(module: string): string[] {
    this.refresh();
    const m = this.cache.get(module);
    return m ? Object.keys(m).sort() : [];
  }

  entry(module: string, key: string): LangEntry | undefined {
    this.refresh();
    const m = this.cache.get(module);
    if (!m || !(key in m)) return undefined;
    return { module, key, locales: m[key] };
  }
}
