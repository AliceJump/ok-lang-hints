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

/* ---------------- gettext PO 支持（参考 ok-script 的 ocr.po 用法） ---------------- */

/** PO 目录配置（相对工作区根，默认 i18n，按 <locale>/LC_MESSAGES/*.po 结构扫描） */
export function poDirectorySetting(): string {
  return vscode.workspace.getConfiguration('okScriptToolkit').get<string>('poDirectory') || 'i18n';
}

/** 是否启用 gettext PO 数据源 */
export function enablePoData(): boolean {
  return vscode.workspace.getConfiguration('okScriptToolkit').get<boolean>('enablePoData', true);
}

/** PO domain 白名单（文件名不含 .po；默认只加载 ocr，排除 ok 等 UI 文案） */
export function poDomainsSetting(): string[] {
  const cfg = vscode.workspace.getConfiguration('okScriptToolkit').get<string[]>('poDomains');
  return cfg && cfg.length ? cfg : ['ocr'];
}

/** PO 条目：msgid（OCR 原文/源文案） -> msgstr（修正/翻译文本） */
export interface PoEntry {
  msgid: string;
  msgstr: string;
}

/** 解析一行 gettext 字符串片段（支持多段 "..." 拼接与 \ 转义） */
function unquoteAll(s: string): string {
  const parts: string[] = [];
  const re = /"(?:[^"\\]|\\.)*"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) parts.push(m[0].slice(1, -1));
  return parts.join('').replace(/\\(.)/g, (_all, c: string) => {
    switch (c) {
      case 'n': return '\n';
      case 't': return '\t';
      case 'r': return '\r';
      case '"': return '"';
      case '\\': return '\\';
      default: return c;
    }
  });
}

/** 解析 gettext PO 文本，返回非空 msgid 的条目（跳过头部元数据） */
export function parsePo(text: string): PoEntry[] {
  const entries: PoEntry[] = [];
  let cur: PoEntry | null = null;
  let section: 'msgid' | 'msgstr' | null = null;
  let sawMsgid = false;
  let sawMsgstr = false;

  const flush = () => {
    if (cur && sawMsgid && sawMsgstr && cur.msgid !== '') entries.push(cur);
    cur = null;
    section = null;
    sawMsgid = false;
    sawMsgstr = false;
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) {
      if (cur && sawMsgid && sawMsgstr) flush();
      continue;
    }
    let m = /^msgid\s+(.*)$/.exec(line);
    if (m) {
      if (cur && sawMsgid && sawMsgstr) flush();
      if (!cur) cur = { msgid: '', msgstr: '' };
      section = 'msgid';
      sawMsgid = true;
      cur.msgid = unquoteAll(m[1]);
      continue;
    }
    m = /^msgstr\s+(.*)$/.exec(line);
    if (m) {
      if (!cur) cur = { msgid: '', msgstr: '' };
      section = 'msgstr';
      sawMsgstr = true;
      cur.msgstr = unquoteAll(m[1]);
      continue;
    }
    if (/^msgctxt\s/.test(line)) {
      // 忽略 msgctxt，仅作为新条目边界
      if (cur && sawMsgid && sawMsgstr) flush();
      if (!cur) cur = { msgid: '', msgstr: '' };
      section = 'msgid';
      continue;
    }
    // 多行字符串续行："..."（属于上一行 msgid/msgstr）
    if (line.startsWith('"')) {
      if (!cur) cur = { msgid: '', msgstr: '' };
      const v = unquoteAll(line);
      if (section === 'msgstr') cur.msgstr += v;
      else {
        cur.msgid += v;
        section = 'msgid';
      }
      continue;
    }
    // 其他关键字（msgid_plural 等）忽略
  }
  if (cur && sawMsgid && sawMsgstr && cur.msgid !== '') entries.push(cur);
  return entries;
}

/** 含空格时生成去空格副本（参考 ok-script duplicate_spaced_msgids） */
function spacedKeys(msgid: string): string[] {
  const noSpace = msgid.replace(/\s+/g, '');
  return noSpace !== '' && noSpace !== msgid ? [msgid, noSpace] : [msgid];
}

/** 加载 assets/lang/*.json 与 <poDirectory>/<locale>/LC_MESSAGES/*.po 并缓存（按 mtime 增量刷新） */
export class LangData {
  private rootDir: string;
  private jsonCache = new Map<string, ModuleDict>();
  private poCache = new Map<string, ModuleDict>();
  private poFiles = new Map<string, { domain: string; locale: string; entries: PoEntry[] }>();
  private merged = new Map<string, ModuleDict>();
  private mtimes = new Map<string, number>();
  private poMtimes = new Map<string, number>();

  constructor(root: vscode.WorkspaceFolder | undefined) {
    this.rootDir = root ? root.uri.fsPath : '';
  }

  private langDir(): string {
    const rel = vscode.workspace.getConfiguration('okScriptToolkit').get<string>('langDirectory') || 'assets/lang';
    return path.join(this.rootDir, rel);
  }

  private poRoot(): string {
    return path.join(this.rootDir, poDirectorySetting());
  }

  /** 强制全量刷新 */
  refresh(force = false): void {
    this.refreshJson(force);
    this.refreshPo(force);
    this.rebuildMerged();
  }

  /** 扫描 assets/lang/*.json（按 mtime 增量） */
  private refreshJson(force: boolean): void {
    const dir = this.langDir();
    if (force) {
      this.jsonCache.clear();
      this.mtimes.clear();
    }
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
          this.jsonCache.set(moduleName, raw as ModuleDict);
        }
      } catch {
        // 跳过坏文件
      }
    }
    // 删除已消失的模块
    for (const mod of [...this.jsonCache.keys()]) {
      if (!seen.has(mod)) this.jsonCache.delete(mod);
    }
  }

  /** 扫描 <poDirectory>/<locale>/LC_MESSAGES/*.po（按 mtime 增量） */
  private refreshPo(force: boolean): void {
    this.poCache.clear();
    if (!enablePoData()) return;
    const root = this.poRoot();
    if (!this.rootDir || !fs.existsSync(root)) return;

    const seen = new Set<string>();
    for (const localeDir of fs.readdirSync(root, { withFileTypes: true })) {
      if (!localeDir.isDirectory()) continue;
      const lc = path.join(root, localeDir.name, 'LC_MESSAGES');
      if (!fs.existsSync(lc)) continue;
      for (const f of fs.readdirSync(lc)) {
        if (!f.endsWith('.po')) continue;
        const domain = f.replace(/\.po$/, '');
        // 只加载白名单内的 domain（如 ocr），排除 ok.po 等 UI/任务通用文案
        if (!poDomainsSetting().includes(domain)) continue;
        const fp = path.join(lc, f);
        seen.add(fp);
        try {
          const m = fs.statSync(fp).mtimeMs;
          if (force || this.poMtimes.get(fp) !== m) {
            this.poMtimes.set(fp, m);
            this.poFiles.set(fp, {
              domain,
              locale: localeDir.name,
              entries: parsePo(fs.readFileSync(fp, 'utf-8')),
            });
          }
        } catch {
          // 跳过坏文件
        }
      }
    }
    // 删除已消失的 po 文件
    for (const fp of [...this.poFiles.keys()]) {
      if (!seen.has(fp)) {
        this.poFiles.delete(fp);
        this.poMtimes.delete(fp);
      }
    }
    // 按 domain 聚合：msgid（及去空格副本）-> locale -> { string: msgstr }
    for (const { domain, locale, entries } of this.poFiles.values()) {
      let dict = this.poCache.get(domain);
      if (!dict) {
        dict = {};
        this.poCache.set(domain, dict);
      }
      for (const e of entries) {
        // 空 msgstr 视为未翻译，回退为 msgid 原文（类似 gettext 行为）
        const value = e.msgstr !== '' ? e.msgstr : e.msgid;
        const node: LangNode = { string: value };
        for (const key of spacedKeys(e.msgid)) {
          let locales = dict[key];
          if (!locales) {
            locales = {};
            dict[key] = locales;
          }
          locales[locale] = node;
        }
      }
    }
  }

  /**
   * 合并 JSON 模块（self.lang 数据）。
   * 注意：PO 数据（如 ocr.po）不作为 self.lang 模块暴露，
   * 而是通过 poEntry / poKeys 提供给 OCR 函数 match 参数提示使用。
   */
  private rebuildMerged(): void {
    this.merged.clear();
    for (const [mod, dict] of this.jsonCache) {
      this.merged.set(mod, { ...dict });
    }
  }

  modules(): string[] {
    this.refresh();
    return [...this.merged.keys()].sort();
  }

  keys(module: string): string[] {
    this.refresh();
    const m = this.merged.get(module);
    return m ? Object.keys(m).sort() : [];
  }

  /** 查 JSON 模块的 key；未命中时去掉空格再查 */
  entry(module: string, key: string): LangEntry | undefined {
    this.refresh();
    const m = this.merged.get(module);
    if (!m) return undefined;
    let locales = m[key];
    if (!locales) {
      const noSpace = key.replace(/\s+/g, '');
      if (noSpace !== key) locales = m[noSpace];
    }
    if (!locales) return undefined;
    return { module, key, locales };
  }

  /** PO domain 的全部 key（用于 OCR match 正则补全） */
  poKeys(domain: string): string[] {
    this.refresh();
    const m = this.poCache.get(domain);
    return m ? Object.keys(m).sort() : [];
  }

  /** 查 PO domain 的条目（用于 OCR match 提示）；未命中时去掉空格再查 */
  poEntry(domain: string, key: string): LangEntry | undefined {
    this.refresh();
    const m = this.poCache.get(domain);
    if (!m) return undefined;
    let locales = m[key];
    if (!locales) {
      const noSpace = key.replace(/\s+/g, '');
      if (noSpace !== key) locales = m[noSpace];
    }
    if (!locales) return undefined;
    return { module: domain, key, locales };
  }
}
