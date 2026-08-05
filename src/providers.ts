import * as vscode from 'vscode';
import {
  LangData,
  LangEntry,
  LOCALE_ORDER,
  normalizeLocale,
  nodeType,
  nodeValue,
  pickEntry,
} from './langData';
import { FeatureData, FeatureTemplate } from './featureData';
import { cropTemplateToDataUrlCached } from './pngCrop';

/** 匹配 self.lang.<模块>.<key>（负向后视避免匹配 self.langx 之类） */
const EXPR_RE = /(?<![\w.])self\.lang\.([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)/g;

/** 转义正则特殊字符（别名可能含 . 等） */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 可配置的 FeatureList 别名，如 fL / FeatureList */
export function featureAliases(): string[] {
  const cfg = vscode.workspace.getConfiguration('okLangHints').get<string[]>('featureAliases');
  return cfg && cfg.length ? cfg : ['fL', 'FeatureList'];
}

/** 构建匹配 别名.<模板名> 的正则 */
function featureRe(): RegExp {
  const alts = featureAliases().map(escapeRegExp).join('|');
  return new RegExp(`(?<![\\w.])(${alts})\\.([A-Za-z0-9_]+)`, 'g');
}

interface Match {
  module: string;
  key: string;
  start: number;
  end: number;
}

interface FeatureMatch {
  name: string;
  start: number;
  end: number;
}

function findMatches(line: string): Match[] {
  const out: Match[] = [];
  EXPR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = EXPR_RE.exec(line)) !== null) {
    out.push({ module: m[1], key: m[2], start: m.index, end: m.index + m[0].length });
  }
  return out;
}

function findFeatureMatches(line: string): FeatureMatch[] {
  const re = featureRe();
  const out: FeatureMatch[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    out.push({ name: m[2], start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** 当前显示的 locale（auto 跟随 UI 语言） */
export function currentLocale(): string {
  const d = vscode.workspace.getConfiguration('okLangHints').get<string>('displayLocale') || 'auto';
  return d === 'auto' ? normalizeLocale(vscode.env.language) : d;
}

/** 转义表格单元格内容，避免破坏 Markdown 表格 */
function escapeCell(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/`/g, '\\`')
    .replace(/\r/g, ' ')
    .replace(/\n/g, ' ');
}

/** 生成 hover / tooltip 的 Markdown：全部语言的值表格（区分 string / pattern） */
function formatEntry(entry: LangEntry, locale: string): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.appendCodeblock(`self.lang.${entry.module}.${entry.key}`, 'python');
  const rows = LOCALE_ORDER.map((l) => {
    const node = entry.locales[l];
    const v = nodeValue(node);
    const t = nodeType(node);
    const mark = l === locale ? ' **← 当前**' : '';
    const valCell = v !== undefined ? `\`${escapeCell(v)}\`` : '—';
    const typeCell = t !== undefined ? `\`${t}\`` : '—';
    return `| ${l} | ${typeCell} | ${valCell} |${mark}`;
  }).join('\n');
  md.appendMarkdown(`\n\n| 语言 | 类型 | 值 |\n| --- | --- | --- |\n${rows}`);
  return md;
}

/** 生成幽灵注释标签：string 用「」，pattern 用 ~ ~ 以作区分 */
function hintLabel(value: string, type: 'string' | 'pattern' | undefined): string {
  return type === 'pattern' ? `~${value}~` : `「${value}」`;
}

/** 生成 feature 模板的预览：图片 + 元信息（带缓存） */
function formatFeature(ft: FeatureTemplate): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.appendCodeblock(`fL.${ft.name}`, 'python');
  const img = cropTemplateToDataUrlCached(ft.imagePath, ft.bbox);
  if (img) {
    md.appendMarkdown(`\n![模板预览](${img})\n`);
  } else {
    md.appendMarkdown('\n*(无法渲染模板预览)*\n');
  }
  md.appendMarkdown(
    `\n- 模板名: \`${ft.name}\`` +
      `\n- 尺寸: \`${ft.width} × ${ft.height}\`` +
      `\n- 来源: \`${ft.imagePath}\`` +
      `\n- bbox: \`x=${ft.bbox[0]} y=${ft.bbox[1]} w=${ft.bbox[2]} h=${ft.bbox[3]}\``,
  );
  return md;
}

/** 幽灵注释：仅在 self.lang.X.Y 表达式末尾显示当前语言的值（模板不做幽灵注释） */
export class LangInlayHintsProvider implements vscode.InlayHintsProvider {
  private _emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeInlayHints = this._emitter.event;

  constructor(private data: LangData, private features: FeatureData) {}

  fire(): void {
    this._emitter.fire();
  }

  provideInlayHints(
    document: vscode.TextDocument,
    range: vscode.Range,
    token: vscode.CancellationToken,
  ): vscode.InlayHint[] {
    if (!vscode.workspace.getConfiguration('okLangHints').get<boolean>('enableInlayHints', true)) {
      return [];
    }
    const locale = currentLocale();
    const hints: vscode.InlayHint[] = [];
    for (let line = range.start.line; line <= range.end.line; line++) {
      if (token.isCancellationRequested) break;
      const text = document.lineAt(line).text;
      for (const mt of findMatches(text)) {
        const entry = this.data.entry(mt.module, mt.key);
        if (!entry) continue;
        const picked = pickEntry(entry, locale);
        if (picked.value === undefined) continue;
        const hint = new vscode.InlayHint(
          new vscode.Position(line, mt.end),
          hintLabel(picked.value, picked.type),
        );
        hint.tooltip = formatEntry(entry, locale);
        hints.push(hint);
      }
    }
    return hints;
  }
}

/** 悬浮提示：显示该 key 的全部语言值 / feature 模板预览 */
export class LangHoverProvider implements vscode.HoverProvider {
  constructor(private data: LangData, private features: FeatureData) {}

  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
  ): vscode.Hover | undefined {
    const line = document.lineAt(position.line).text;
    for (const mt of findMatches(line)) {
      if (position.character >= mt.start && position.character <= mt.end) {
        const entry = this.data.entry(mt.module, mt.key);
        if (entry) return new vscode.Hover(formatEntry(entry, currentLocale()));
      }
    }
    for (const mf of findFeatureMatches(line)) {
      if (position.character >= mf.start && position.character <= mf.end) {
        const ft = this.features.entry(mf.name);
        if (ft) return new vscode.Hover(formatFeature(ft));
      }
    }
    return undefined;
  }
}

/** 自动补全：self.lang. -> 模块；self.lang.<模块>. -> key（带值预览）；别名. -> 模板名。 */
export class LangCompletionProvider implements vscode.CompletionItemProvider {
  constructor(private data: LangData, private features: FeatureData) {}

  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
    _context: vscode.CompletionContext,
  ): vscode.CompletionItem[] | undefined {
    const before = document.lineAt(position.line).text.slice(0, position.character);

    // 别名. -> 补全模板名（如 fL. / FeatureList.；缩略图懒加载）
    // 使用极小 sortText，并默认选中模板项；Pylance 的同名枚举项仍保留在列表中。
    for (const alias of featureAliases()) {
      if (!before.endsWith(alias + '.')) continue;
      const prefix = before.slice(0, before.length - alias.length - 1);
      if (/[\w.]$/.test(prefix)) continue; // 别名前是单词字符/点（如 xfL.、self.fL.），不匹配
      return this.features.names().map((name, i) => {
        const ft = this.features.entry(name);
        const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Value);
        if (ft) {
          item.detail = `${ft.width}×${ft.height}`;
          item.sortText = '\u0000' + String(i).padStart(3, '0') + name;
          item.preselect = true;
        }
        return item;
      });
    }

    // self.lang.<模块>.  -> 补全 key
    const keyMatch = /(?<![\w.])self\.lang\.([A-Za-z0-9_]+)\.$/.exec(before);
    if (keyMatch) {
      const module = keyMatch[1];
      const locale = currentLocale();
      return this.data.keys(module).map((k) => {
        const entry = this.data.entry(module, k);
        const picked = entry ? pickEntry(entry, locale) : undefined;
        const item = new vscode.CompletionItem(k, vscode.CompletionItemKind.Field);
        if (picked?.value !== undefined) {
          item.detail = hintLabel(picked.value, picked.type);
        }
        if (entry) item.documentation = formatEntry(entry, locale);
        return item;
      });
    }

    // self.lang. -> 补全模块
    if (/(?<![\w.])self\.lang\.$/.test(before)) {
      return this.data.modules().map((m) => {
        const item = new vscode.CompletionItem(m, vscode.CompletionItemKind.Module);
        item.detail = `${this.data.keys(m).length} keys`;
        return item;
      });
    }

    return undefined;
  }

  /** 懒加载：用户选中/悬停某个补全项时，才生成该模板的缩略图预览 */
  resolveCompletionItem(item: vscode.CompletionItem): vscode.CompletionItem {
    const name = typeof item.label === 'string' ? item.label : '';
    const ft = name ? this.features.entry(name) : undefined;
    if (ft) item.documentation = formatFeature(ft);
    return item;
  }
}
