import * as vscode from 'vscode';
import { EffectData } from './effectData';
import { effectHintLabel, findEffectRefs, formatEffect } from './providers';

/**
 * 效果 ID 悬浮提示（面向 JSON / JSONC 等数据文件）。
 *
 * 匹配 "effect_id": "ATTACH_ELECTROMAGNETIC"、effects: ["ATTACH_COLD"] 等场景，
 * 命中时显示效果 ID 的分类与中文描述。Python 场景继续由 LangHoverProvider 处理，
 * 此 provider 只注册到 json / jsonc，避免与 Python 侧重复。
 */
export class EffectHoverProvider implements vscode.HoverProvider {
  constructor(private effects: EffectData) {}

  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
  ): vscode.Hover | undefined {
    const line = document.lineAt(position.line).text;
    for (const ef of findEffectRefs(line)) {
      if (position.character >= ef.start && position.character <= ef.end) {
        const entry = this.effects.entry(ef.id);
        if (entry) return new vscode.Hover(formatEffect(entry));
      }
    }
    return undefined;
  }
}

/**
 * 效果 ID 自动补全（面向 JSON / JSONC 等数据文件）。
 *
 * 在 "effect_id": " 或 "effect": " 的引号内补全全部效果 ID；
 * 引号内已输入前缀（如 ATTACH_）时按前缀过滤并原位替换。
 */
export class EffectCompletionProvider implements vscode.CompletionItemProvider {
  constructor(private effects: EffectData) {}

  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
    _context: vscode.CompletionContext,
  ): vscode.CompletionItem[] | undefined {
    const before = document.lineAt(position.line).text.slice(0, position.character);
    // 引号内已有前缀（大写/小写/数字/下划线）也继续触发。
    // 兼容 JSON 键带引号（"effect_id": "）与 Python 键无引号（effect_id: "）两种写法。
    const effectIdRe = /(?:effect_id|effect)["']?\s*:\s*r?['"]([A-Za-z0-9_]*)$/;
    const idMatch = effectIdRe.exec(before);
    if (!idMatch) return undefined;
    const prefix = idMatch[1];
    // 让补全项原位替换引号内已有的前缀（而非插入到末尾）
    const range = new vscode.Range(
      position.line,
      position.character - prefix.length,
      position.line,
      position.character,
    );
    const ids = prefix
      ? this.effects.ids().filter((id) => id.toUpperCase().startsWith(prefix.toUpperCase()))
      : this.effects.ids();
    return ids.map((id) => {
      const entry = this.effects.entry(id);
      const item = new vscode.CompletionItem(id, vscode.CompletionItemKind.EnumMember);
      item.range = range;
      if (entry) {
        item.detail = `[${entry.category}] ${entry.description}`;
        item.documentation = formatEffect(entry);
        item.sortText = entry.category + id;
      }
      return item;
    });
  }
}

/**
 * 效果 ID 幽灵注释（面向 JSON / JSONC 等数据文件）。
 *
 * 在 "effect_id": "ATTACH_NATURAL" 后行内显示效果的中文描述。
 */
export class EffectInlayHintsProvider implements vscode.InlayHintsProvider {
  private _emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeInlayHints = this._emitter.event;

  constructor(private effects: EffectData) {}

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
    const hints: vscode.InlayHint[] = [];
    for (let line = range.start.line; line <= range.end.line; line++) {
      if (token.isCancellationRequested) break;
      const text = document.lineAt(line).text;
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
    return hints;
  }
}
