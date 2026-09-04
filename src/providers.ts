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
import { EffectData, EffectEntry } from './effectData';
import { cropTemplateToDataUrlCached } from './pngCrop';
import { tr } from './localization';

/** 匹配 self.lang.<模块>.<key>（支持 Unicode 标识符，如中文 OCR 文本；负向后视避免匹配 self.langx 之类） */
const EXPR_RE = /(?<![\w.])self\.lang\.([\p{L}\p{N}_]+)\.([\p{L}\p{N}_]+)/gu;

/** 转义正则特殊字符（别名可能含 . 等） */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 可配置的 FeatureList 别名，如 fL / FeatureList */
export function featureAliases(): string[] {
  const cfg = vscode.workspace.getConfiguration('okScriptToolkit').get<string[]>('featureAliases');
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

/* ---------------- 技能效果 ID 提示（EffectType.XXX / "effect_id": "XXX"） ---------------- */

/** 效果 ID 引用：EffectType.成员名 或 字符串字面量（effect_id / effect 键值） */
interface EffectRef {
  id: string;
  start: number;
  end: number;
}

/** 匹配 EffectType.成员名（成员名为大写字母/数字/下划线） */
const EFFECT_TYPE_REF_RE = /\bEffectType\.([A-Z][A-Z0-9_]*)/g;

/** 匹配字符串字面量中的效果 ID（大写字母/数字/下划线，长度>=3），用于 effect_id: "XXX" / "effect": "XXX" 等键 */
const EFFECT_STR_RE = /r?['"]([A-Z][A-Z0-9_]{2,})['"]/g;

/** 在单行中查找所有效果 ID 引用（枚举访问 + 字符串字面量） */
export function findEffectRefs(line: string): EffectRef[] {
  const out: EffectRef[] = [];
  // 1) EffectType.XXX 枚举访问（需确认该成员存在于效果数据中再提示）
  EFFECT_TYPE_REF_RE.lastIndex = 0;
  let em: RegExpExecArray | null;
  while ((em = EFFECT_TYPE_REF_RE.exec(line)) !== null) {
    out.push({ id: em[1], start: em.index, end: em.index + em[0].length });
  }
  // 2) 字符串字面量 "XXX"（如 effect_id: "ATTACH_COLD"、effects: ["ATTACH_COLD"]）
  //    排除 self.lang 与 .po 相关的字符串（它们也会被本正则命中）
  EFFECT_STR_RE.lastIndex = 0;
  let sm: RegExpExecArray | null;
  while ((sm = EFFECT_STR_RE.exec(line)) !== null) {
    const before = line.slice(Math.max(0, sm.index - 40), sm.index);
    // 跳过 self.lang.xxx、match=、re.compile( 等场景
    if (/self\.lang\.|match\s*=|re\.compile\s*\(/.test(before)) continue;
    out.push({ id: sm[1], start: sm.index, end: sm.index + sm[0].length });
  }
  return out;
}

/** 生成效果条目的 Markdown：ID + 分类 + 描述 */
export function formatEffect(entry: EffectEntry): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.appendCodeblock(entry.id, 'python');
  md.appendMarkdown(
    `\n- ${tr('Category')}: \`${entry.category}\`` + `\n- ${tr('Description')}: ${entry.description}`,
  );
  return md;
}

/** 生成幽灵注释标签：效果 ID 显示描述 */
export function effectHintLabel(entry: EffectEntry): string {
  return `「${entry.description}」`;
}

/* ---------------- OCR 函数 match 参数提示（参考 ok-script fix_match_regex） ---------------- */

/** 带 match 参数的 OCR 函数（运行时正则会被 ocr.po 翻译修正后重新编译） */
const OCR_CALL_RE = /(?<![\w.])self\.(ocr|wait_ocr|wait_click_ocr|find_boxes)\(/g;

/** OCR match 参数引用：提取出的 pattern + 位置信息 */
interface OcrMatchRef {
  pattern: string;
  isRegex: boolean;
  start: number;
  end: number;
  hintEnd: number;
}

/** 从 '(' 开始提取配平的括号内容（跳过字符串字面量） */
function extractParens(line: string, openIdx: number): { content: string; end: number } | undefined {
  let depth = 0;
  let inStr: string | null = null;
  for (let i = openIdx; i < line.length; i++) {
    const c = line[i];
    if (inStr) {
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      inStr = c;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return { content: line.slice(openIdx + 1, i), end: i };
    }
  }
  return undefined;
}

/** 在参数列表内容中提取关键字参数的值（到顶层逗号或末尾），valueStart 为值在 content 中的偏移 */
function extractKwArg(
  content: string,
  name: string,
): { value: string; valueStart: number } | undefined {
  const re = new RegExp(`(?:^|[,\\s])${name}\\s*=\\s*`);
  const m = re.exec(content);
  if (!m) return undefined;
  const start = m.index + m[0].length;
  let depth = 0;
  let inStr: string | null = null;
  let i = start;
  for (; i < content.length; i++) {
    const c = content[i];
    if (inStr) {
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") {
      inStr = c;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) break;
  }
  const raw = content.slice(start, i);
  const valueStart = start + (raw.length - raw.trimStart().length);
  return { value: raw.trim(), valueStart };
}

/** Python 字符串去转义：仅处理双反斜杠；正则常见的 \d \w 等保持原样 */
function unquotePython(s: string): string {
  return s.replace(/\\\\/g, '\\');
}

/** 提取值中的字符串字面量（支持 r 前缀与单/双引号），返回相对值的偏移 */
function extractStringLiterals(value: string): { text: string; offset: number }[] {
  const out: { text: string; offset: number }[] = [];
  const re = /r?(['"])((?:[^\\]|\\.)*?)\1/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value)) !== null) {
    out.push({ text: unquotePython(m[2]), offset: m.index });
  }
  return out;
}

/** 在一行中查找 OCR 函数 match 参数引用（支持 re.compile(...) / 字符串 / 列表） */
export function findOcrMatchRefs(line: string): OcrMatchRef[] {
  const out: OcrMatchRef[] = [];
  OCR_CALL_RE.lastIndex = 0;
  let cm: RegExpExecArray | null;
  while ((cm = OCR_CALL_RE.exec(line)) !== null) {
    const openIdx = cm.index + cm[0].length - 1;
    const parens = extractParens(line, openIdx);
    if (!parens) continue;
    const kw = extractKwArg(parens.content, 'match');
    if (!kw) continue;
    const valueAbsStart = cm.index + cm[0].length + kw.valueStart;
    const hintEnd = parens.end + 1;
    // re.compile(...) 正则对象：hover 覆盖整个 re.compile 调用
    const compileRe = /^re\.compile\s*\((.*)\)$/s;
    const cmpl = compileRe.exec(kw.value);
    if (cmpl) {
      const lits = extractStringLiterals(cmpl[1]);
      for (const lit of lits) {
        out.push({
          pattern: lit.text,
          isRegex: true,
          start: valueAbsStart,
          end: valueAbsStart + kw.value.length,
          hintEnd,
        });
      }
      continue;
    }
    // 字符串 / 字符串列表（含 re.compile 元素）
    for (const lit of extractStringLiterals(kw.value)) {
      out.push({
        pattern: lit.text,
        isRegex: false,
        start: valueAbsStart + lit.offset,
        end: valueAbsStart + lit.offset + lit.text.length + 2,
        hintEnd,
      });
    }
  }
  return out;
}

/** 当前显示的 locale（auto 跟随 UI 语言） */
export function currentLocale(): string {
  const d = vscode.workspace.getConfiguration('okScriptToolkit').get<string>('displayLocale') || 'auto';
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
function formatEntry(entry: LangEntry, locale: string, title?: string): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.appendCodeblock(title ?? `self.lang.${entry.module}.${entry.key}`, 'python');
  const rows = LOCALE_ORDER.map((l) => {
    const node = entry.locales[l];
    const v = nodeValue(node);
    const t = nodeType(node);
    const mark = l === locale ? ` **← ${tr('Current')}**` : '';
    const valCell = v !== undefined ? `\`${escapeCell(v)}\`` : '—';
    const typeCell = t !== undefined ? `\`${t}\`` : '—';
    return `| ${l} | ${typeCell} | ${valCell} |${mark}`;
  }).join('\n');
  md.appendMarkdown(`\n\n| ${tr('Language')} | ${tr('Type')} | ${tr('Value')} |\n| --- | --- | --- |\n${rows}`);
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
    md.appendMarkdown(`\n![${tr('Template preview')}](${img})\n`);
  } else {
    md.appendMarkdown(`\n*(${tr('Unable to render template preview')})*\n`);
  }
  md.appendMarkdown(
    `\n- ${tr('Template name')}: \`${ft.name}\`` +
      `\n- ${tr('Size')}: \`${ft.width} × ${ft.height}\`` +
      `\n- ${tr('Source')}: \`${ft.imagePath}\`` +
      `\n- bbox: \`x=${ft.bbox[0]} y=${ft.bbox[1]} w=${ft.bbox[2]} h=${ft.bbox[3]}\``,
  );
  return md;
}

/** 幽灵注释：仅在 self.lang.X.Y 表达式末尾显示当前语言的值（模板不做幽灵注释） */
export class LangInlayHintsProvider implements vscode.InlayHintsProvider {
  private _emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeInlayHints = this._emitter.event;

  constructor(
    private data: LangData,
    private features: FeatureData,
    private effects?: EffectData,
  ) {}

  fire(): void {
    this._emitter.fire();
  }

  provideInlayHints(
    document: vscode.TextDocument,
    range: vscode.Range,
    token: vscode.CancellationToken,
  ): vscode.InlayHint[] {
    if (!vscode.workspace.getConfiguration('okScriptToolkit').get<boolean>('enableInlayHints', true)) {
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
      // OCR 函数的 match 正则：运行时会被 ocr.po 翻译修正，行尾提示翻译结果
      for (const om of findOcrMatchRefs(text)) {
        const entry = this.data.poEntry('ocr', om.pattern);
        if (!entry) continue;
        const picked = pickEntry(entry, locale);
        if (picked.value === undefined) continue;
        const hint = new vscode.InlayHint(
          new vscode.Position(line, om.hintEnd),
          `→ ${picked.value}`,
        );
        hint.tooltip = formatEntry(entry, locale, `match=re.compile(r"${om.pattern}")`);
        hints.push(hint);
      }
      // 技能效果 ID：EffectType.XXX 或 "effect_id": "XXX" 后显示中文描述
      if (this.effects) {
        for (const ef of findEffectRefs(text)) {
          const entry = this.effects.entry(ef.id);
          if (!entry) continue;
          const hint = new vscode.InlayHint(
            new vscode.Position(line, ef.end),
            effectHintLabel(entry),
          );
          hint.tooltip = formatEffect(entry);
          hints.push(hint);
        }
      }
    }
    return hints;
  }
}

/** 悬浮提示：显示该 key 的全部语言值 / feature 模板预览 / 效果 ID 描述 */
export class LangHoverProvider implements vscode.HoverProvider {
  constructor(
    private data: LangData,
    private features: FeatureData,
    private effects?: EffectData,
  ) {}

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
    // OCR 函数的 match 正则：hover 显示 ocr.po 中的修正映射
    for (const om of findOcrMatchRefs(line)) {
      if (position.character >= om.start && position.character <= om.end) {
        const entry = this.data.poEntry('ocr', om.pattern);
        if (!entry) continue;
        const md = formatEntry(entry, currentLocale(), `match=re.compile(r"${om.pattern}")`);
        md.appendMarkdown(`\n\n> ${tr('At runtime, fix_match_regex translates this pattern using ocr.po before calling re.compile.')}`);
        return new vscode.Hover(md);
      }
    }
    // 技能效果 ID：hover 显示 ID 分类与中文描述
    if (this.effects) {
      for (const ef of findEffectRefs(line)) {
        if (position.character >= ef.start && position.character <= ef.end) {
          const entry = this.effects.entry(ef.id);
          if (entry) return new vscode.Hover(formatEffect(entry));
        }
      }
    }
    return undefined;
  }
}

/** 自动补全：self.lang. -> 模块；self.lang.<模块>. -> key（带值预览）；别名. -> 模板名；effect_id: " -> 效果 ID。 */
export class LangCompletionProvider implements vscode.CompletionItemProvider {
  constructor(
    private data: LangData,
    private features: FeatureData,
    private effects?: EffectData,
  ) {}

  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
    _context: vscode.CompletionContext,
  ): vscode.CompletionItem[] | undefined {
    const before = document.lineAt(position.line).text.slice(0, position.character);

    // 技能效果 ID 补全：在 effect_id: " 或 effect: " 的引号内补全效果 ID
    if (this.effects) {
      const effectIdRe = /(?:effect_id|effect)\s*:\s*r?['"]$/;
      if (effectIdRe.test(before)) {
        return this.effects.ids().map((id) => {
          const entry = this.effects!.entry(id);
          const item = new vscode.CompletionItem(id, vscode.CompletionItemKind.EnumMember);
          if (entry) {
            item.detail = `[${entry.category}] ${entry.description}`;
            item.documentation = formatEffect(entry);
            item.sortText = entry.category + id;
          }
          return item;
        });
      }
    }

    // OCR 函数的 match 正则补全：在 re.compile(" 或 match=" 的引号内补全 ocr.po 的 key
    const ocrMatchRe =
      /self\.(ocr|wait_ocr|wait_click_ocr|find_boxes)\([^)]*?(?:re\.compile\s*\(\s*|match\s*=\s*)r?['"]$/;
    if (ocrMatchRe.test(before)) {
      const locale = currentLocale();
      return this.data.poKeys('ocr').map((k) => {
        const entry = this.data.poEntry('ocr', k);
        const item = new vscode.CompletionItem(k, vscode.CompletionItemKind.Value);
        if (entry) {
          const picked = pickEntry(entry, locale);
          if (picked?.value !== undefined) item.detail = `→ ${picked.value}`;
          item.documentation = formatEntry(entry, locale, `match=re.compile(r"${k}")`);
        }
        return item;
      });
    }

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
    const keyMatch = /(?<![\w.])self\.lang\.([\p{L}\p{N}_]+)\.$/u.exec(before);
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
        item.detail = tr('{count} keys', { count: this.data.keys(m).length });
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
