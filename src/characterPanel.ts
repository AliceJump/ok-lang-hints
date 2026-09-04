import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  CharacterDataLoadResult,
  CharacterDataPaths,
  CharacterDataSources,
  configuredCharacterDataPaths,
  loadCharacterManagerData,
} from './characterData';
import { FeatureData, FeatureTemplate } from './featureData';
import { injectWebviewLocalization, tr, webviewStrings } from './localization';
import {
  clearCropCache,
  cropTemplateThumbFileAsync,
  removeTemplateThumbFile,
  templateThumbFilePath,
  warmCropCache,
  THUMB_HEIGHT,
} from './pngCrop';

export interface CharacterManagerDependencies {
  extensionUri: vscode.Uri;
  features: FeatureData;
  thumbDir: string;
}

const DEFAULT_AVATAR_TEMPLATE_REGEX = '^battle[_-]?icon[_-]?';

interface CharacterManagerMessage {
  type?: string;
  kind?: string;
  characterId?: string;
  fileName?: string;
  skillId?: string;
  effectId?: string;
  text?: string;
  action?: string;
  enhancementIndex?: number;
  data?: unknown;
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(tr('{name} cannot be empty', { name }));
  return value.trim();
}

function optionalString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function effectArray(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(tr('{name} must be a JSON array', { name }));
  for (const item of value) {
    if (typeof item === 'string') continue;
    if (!isObject(item) || typeof item.effect_id !== 'string' || !item.effect_id.trim()) {
      throw new Error(tr('Each item in {name} must be an effect ID string or an object containing effect_id', { name }));
    }
  }
  return value;
}

function getNonce(): string {
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';
  for (let index = 0; index < 32; index++) value += possible.charAt(Math.floor(Math.random() * possible.length));
  return value;
}

function resolveProjectDir(): string {
  const configuration = vscode.workspace.getConfiguration('okScriptToolkit');
  const explicit = configuration.get<string>('characterProjectPath')?.trim();
  const taskProject = configuration.get<string>('okScriptProjectPath')?.trim();
  const selected = explicit || taskProject;
  if (selected) {
    const expanded = selected.replace(/^~/, process.env.USERPROFILE || '').replace(/[\\/]+$/, '');
    return path.resolve(expanded);
  }
  const folders = vscode.workspace.workspaceFolders || [];
  const matching = folders.find((folder) =>
    fs.existsSync(path.join(folder.uri.fsPath, 'assets', 'data', 'characters.json')) ||
    fs.existsSync(path.join(folder.uri.fsPath, 'assets', 'data', 'character_skills')),
  );
  return matching?.uri.fsPath || folders[0]?.uri.fsPath || '';
}

function configuredPaths(projectDir: string): CharacterDataPaths {
  const configuration = vscode.workspace.getConfiguration('okScriptToolkit');
  return configuredCharacterDataPaths(projectDir, {
    masterFile: configuration.get<string>('characterMasterFile'),
    skillsDirectory: configuration.get<string>('characterSkillsDirectory'),
    localeFile: configuration.get<string>('characterLocaleFile'),
    effectsFile: configuration.get<string>('effectsFile'),
  });
}

function normalizedAvatarKey(value: string | undefined): string {
  return (value || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
}

function samePath(first: string, second: string): boolean {
  const normalize = (value: string) => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return !!first && !!second && normalize(first) === normalize(second);
}

function avatarTemplateRegex(): RegExp | undefined {
  const configured = vscode.workspace.getConfiguration('okScriptToolkit')
    .get<string>('characterAvatarTemplateRegex')?.trim() || DEFAULT_AVATAR_TEMPLATE_REGEX;
  try {
    return new RegExp(configured, 'i');
  } catch {
    return new RegExp(DEFAULT_AVATAR_TEMPLATE_REGEX, 'i');
  }
}

interface AvatarTemplateIndex {
  byKey: Map<string, FeatureTemplate>;
  matched: FeatureTemplate[];
}

function avatarTemplateIndex(features: FeatureData): AvatarTemplateIndex {
  const regex = avatarTemplateRegex();
  const byKey = new Map<string, FeatureTemplate>();
  const matched: FeatureTemplate[] = [];
  if (!regex) return { byKey, matched };
  for (const template of features.all()) {
    regex.lastIndex = 0;
    const match = regex.exec(template.name);
    if (!match) continue;
    matched.push(template);
    const key = normalizedAvatarKey(match[1] || template.name.slice(match.index + match[0].length));
    if (key && !byKey.has(key)) byKey.set(key, template);
  }
  return { byKey, matched };
}

export class CharacterManagerPanel implements vscode.Disposable {
  static current: CharacterManagerPanel | undefined;

  static show(dependencies: CharacterManagerDependencies): void {
    if (CharacterManagerPanel.current) {
      CharacterManagerPanel.current.panel.reveal(vscode.ViewColumn.One);
      void CharacterManagerPanel.current.update(true);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'okScriptToolkitCharacterManager',
      tr('Character & Skill Manager'),
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(dependencies.extensionUri, 'media', 'characterManager'),
          vscode.Uri.file(dependencies.thumbDir),
        ],
      },
    );
    CharacterManagerPanel.current = new CharacterManagerPanel(panel, dependencies);
  }

  static refreshCurrent(): void {
    if (CharacterManagerPanel.current) void CharacterManagerPanel.current.update(false);
  }

  private readonly disposables: vscode.Disposable[] = [];
  private watcherDisposables: vscode.Disposable[] = [];
  private sources: CharacterDataSources | undefined;
  private projectDir = '';
  private generation = 0;
  private refreshTimer: NodeJS.Timeout | undefined;
  private disposed = false;
  private projectFeatures: FeatureData | undefined;
  private avatarRefreshPending = false;

  private constructor(
    readonly panel: vscode.WebviewPanel,
    private readonly dependencies: CharacterManagerDependencies,
  ) {
    this.disposables.push(
      panel.webview.onDidReceiveMessage((message: CharacterManagerMessage) => {
        void this.onMessage(message);
      }),
      panel.onDidDispose(() => this.dispose()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          event.affectsConfiguration('okScriptToolkit.characterProjectPath') ||
          event.affectsConfiguration('okScriptToolkit.characterMasterFile') ||
          event.affectsConfiguration('okScriptToolkit.characterSkillsDirectory') ||
          event.affectsConfiguration('okScriptToolkit.characterLocaleFile') ||
          event.affectsConfiguration('okScriptToolkit.characterAvatarTemplateRegex') ||
          event.affectsConfiguration('okScriptToolkit.effectsFile') ||
          event.affectsConfiguration('okScriptToolkit.okScriptProjectPath')
        ) {
          void this.update(true);
        }
      }),
    );
    panel.webview.html = this.buildHtml(panel.webview);
  }

  private buildHtml(webview: vscode.Webview): string {
    const file = path.join(this.dependencies.extensionUri.fsPath, 'media', 'characterManager', 'index.html');
    try {
      const nonce = getNonce();
      const resource = (name: string) => webview.asWebviewUri(
        vscode.Uri.joinPath(this.dependencies.extensionUri, 'media', 'characterManager', name),
      ).toString(true);
      return injectWebviewLocalization(
        fs.readFileSync(file, 'utf-8')
          .split('__CSP_NONCE__').join(nonce)
          .split('__CSP_SOURCE__').join(webview.cspSource)
          .split('__STYLE_URI__').join(resource('characterManager.css'))
          .split('__APP_SCRIPT_URI__').join(resource('app.js')),
      );
    } catch (error) {
      return `<!DOCTYPE html><html><meta charset="UTF-8"><body style="font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:20px">${tr('Unable to read character manager panel: {error}', { error: error instanceof Error ? error.message : String(error) })}</body></html>`;
    }
  }

  private async onMessage(message: CharacterManagerMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        await this.update(false);
        break;
      case 'refresh':
        await this.update(true);
        break;
      case 'openSource':
        await this.openSource(message);
        break;
      case 'copy':
        if (typeof message.text === 'string') {
          await vscode.env.clipboard.writeText(message.text);
          void vscode.window.showInformationMessage(tr('Copied: {text}', { text: message.text }));
        }
        break;
      case 'mutateCharacter':
        await this.mutateCharacter(message);
        break;
      case 'mutateEffect':
        await this.mutateEffect(message);
        break;
      default:
        break;
    }
  }

  private readCharacterFile(characterId: string): { file: string; root: JsonObject } {
    const file = this.sources?.characterFiles.get(characterId);
    if (!file || !fs.existsSync(file)) throw new Error(tr('Skill file for character {id} was not found', { id: characterId }));
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!isObject(parsed)) throw new Error(tr('The character JSON root must be an object'));
    if (!Array.isArray(parsed.skills)) parsed.skills = [];
    return { file, root: parsed };
  }

  private findSkill(root: JsonObject, skillId: string): JsonObject {
    const skills = root.skills as unknown[];
    const skill = skills.find((item) => isObject(item) && item.skill_id === skillId);
    if (!isObject(skill)) throw new Error(tr('Skill {id} was not found', { id: skillId }));
    return skill;
  }

  private readEnhancements(skill: JsonObject): { items: JsonObject[]; singular: boolean } {
    if (Array.isArray(skill.enhancements)) {
      return { items: skill.enhancements.filter(isObject), singular: false };
    }
    return { items: isObject(skill.enhancement) ? [skill.enhancement] : [], singular: true };
  }

  private writeEnhancements(skill: JsonObject, items: JsonObject[], singular: boolean): void {
    if (singular && items.length <= 1) {
      skill.enhancement = items[0] || null;
      delete skill.enhancements;
    } else {
      skill.enhancements = items;
      delete skill.enhancement;
    }
    skill.has_enhancement = items.length > 0;
  }

  private sanitizeSkill(data: unknown, existing: JsonObject = {}): JsonObject {
    if (!isObject(data)) throw new Error(tr('Invalid skill data format'));
    return {
      ...existing,
      skill_id: requiredString(data.skillId, tr('Skill ID')),
      name: requiredString(data.name, tr('Skill name')),
      skill_type: requiredString(data.skillType, tr('Skill type')),
      element: optionalString(data.element) || null,
      description: optionalString(data.description),
      damage_multiplier: optionalString(data.damageMultiplier) || null,
      stagger_value: finiteNumber(data.staggerValue),
      cooldown: optionalString(data.cooldown) || null,
      spirit_cost: finiteNumber(data.spiritCost),
      effects: effectArray(data.effects, tr('Base effects')),
    };
  }

  private sanitizeEnhancement(data: unknown, existing: JsonObject = {}): JsonObject {
    if (!isObject(data)) throw new Error(tr('Invalid enhancement data format'));
    const triggerEffects = effectArray(data.triggerEffects, tr('Trigger dependency effects'))
      .map((item) => typeof item === 'string' ? item : String((item as JsonObject).effect_id));
    const triggerEffectMode = data.triggerEffectMode === 'any' ? 'any' : 'all';
    return {
      ...existing,
      name: requiredString(data.name, tr('Enhancement name')),
      trigger_condition: {
        text: optionalString(data.triggerText),
        effects: { [triggerEffectMode]: triggerEffects },
      },
      enhancement_effect: optionalString(data.enhancementEffect),
      enhancement_visible_pulse: data.visiblePulse === true,
      effects: effectArray(data.effects, tr('Enhancement output effects')),
    };
  }

  private atomicWriteJson(file: string, root: JsonObject): void {
    const backup = `${file}.bak`;
    const temporary = `${file}.ok-lang-hints.tmp`;
    fs.copyFileSync(file, backup);
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(root, null, 2)}\n`, 'utf-8');
      JSON.parse(fs.readFileSync(temporary, 'utf-8'));
      fs.renameSync(temporary, file);
    } catch (error) {
      try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch { /* ignore cleanup */ }
      throw error;
    }
  }

  private async mutateCharacter(message: CharacterManagerMessage): Promise<void> {
    try {
      const characterId = requiredString(message.characterId, tr('Character ID'));
      const { file, root } = this.readCharacterFile(characterId);
      const action = requiredString(message.action, tr('Mutation action'));
      const data = message.data;
      switch (action) {
        case 'updateCharacter':
          throw new Error(tr('Character base information comes from synchronized data and cannot be modified'));
        case 'addSkill': {
          const skill = this.sanitizeSkill(data);
          const skills = root.skills as unknown[];
          if (skills.some((item) => isObject(item) && item.skill_id === skill.skill_id)) {
            throw new Error(tr('Skill ID {id} already exists', { id: String(skill.skill_id) }));
          }
          skill.has_enhancement = false;
          skill.enhancement = null;
          skill._ok_lang_hints_custom = true;
          skills.push(skill);
          break;
        }
        case 'updateSkill': {
          const oldSkillId = requiredString(message.skillId, tr('Original skill ID'));
          const skill = this.findSkill(root, oldSkillId);
          const updated = this.sanitizeSkill(data, skill);
          if (skill._ok_lang_hints_custom !== true) {
            updated.skill_id = oldSkillId;
            updated.name = skill.name;
            updated.skill_type = skill.skill_type;
            updated.element = skill.element;
            updated.description = skill.description;
          }
          const skills = root.skills as unknown[];
          if (updated.skill_id !== oldSkillId && skills.some((item) => isObject(item) && item.skill_id === updated.skill_id)) {
            throw new Error(tr('Skill ID {id} already exists', { id: String(updated.skill_id) }));
          }
          Object.assign(skill, updated);
          break;
        }
        case 'deleteSkill': {
          const skillId = requiredString(message.skillId, tr('Skill ID'));
          const skills = root.skills as unknown[];
          const index = skills.findIndex((item) => isObject(item) && item.skill_id === skillId);
          if (index < 0) throw new Error(tr('Skill {id} was not found', { id: skillId }));
          const skill = skills[index];
          if (!isObject(skill) || skill._ok_lang_hints_custom !== true) throw new Error(tr('Synchronized skills cannot be deleted'));
          skills.splice(index, 1);
          break;
        }
        case 'addEnhancement': {
          const skill = this.findSkill(root, requiredString(message.skillId, tr('Skill ID')));
          const state = this.readEnhancements(skill);
          state.items.push(this.sanitizeEnhancement(data));
          this.writeEnhancements(skill, state.items, state.singular);
          break;
        }
        case 'updateEnhancement': {
          const skill = this.findSkill(root, requiredString(message.skillId, tr('Skill ID')));
          const state = this.readEnhancements(skill);
          const index = message.enhancementIndex;
          if (!Number.isInteger(index) || index! < 0 || index! >= state.items.length) throw new Error(tr('Invalid enhancement index'));
          state.items[index!] = this.sanitizeEnhancement(data, state.items[index!]);
          this.writeEnhancements(skill, state.items, state.singular);
          break;
        }
        case 'deleteEnhancement': {
          const skill = this.findSkill(root, requiredString(message.skillId, tr('Skill ID')));
          const state = this.readEnhancements(skill);
          const index = message.enhancementIndex;
          if (!Number.isInteger(index) || index! < 0 || index! >= state.items.length) throw new Error(tr('Invalid enhancement index'));
          state.items.splice(index!, 1);
          this.writeEnhancements(skill, state.items, state.singular);
          break;
        }
        default:
          throw new Error(tr('Unsupported mutation action: {action}', { action }));
      }
      this.atomicWriteJson(file, root);
      await this.panel.webview.postMessage({ type: 'mutationResult', ok: true, action, characterId });
      await this.update(false);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      await this.panel.webview.postMessage({ type: 'mutationResult', ok: false, text });
      void vscode.window.showErrorMessage(tr('Failed to save character data: {error}', { error: text }));
    }
  }

  private effectsFile(): string {
    const file = this.sources?.effectsFile;
    if (!file || !fs.existsSync(file)) throw new Error(tr('effects.py was not found'));
    return file;
  }

  private atomicWriteText(file: string, content: string): void {
    const backup = `${file}.bak`;
    const temporary = `${file}.ok-lang-hints.tmp`;
    fs.copyFileSync(file, backup);
    try {
      fs.writeFileSync(temporary, content, 'utf-8');
      fs.renameSync(temporary, file);
    } catch (error) {
      try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch { /* ignore cleanup */ }
      throw error;
    }
  }

  private async mutateEffect(message: CharacterManagerMessage): Promise<void> {
    try {
      const action = requiredString(message.action, tr('Effect mutation action'));
      const data = message.data;
      if (!isObject(data)) throw new Error(tr('Invalid effect data format'));
      const file = this.effectsFile();
      let text = fs.readFileSync(file, 'utf-8');
      const eol = text.includes('\r\n') ? '\r\n' : '\n';
      const lines = text.split(/\r?\n/);
      const classStart = lines.findIndex((line) => /^class\s+EffectType\b/.test(line.trim()));
      const descriptionsMarker = lines.findIndex((line, index) => index > classStart && line.trim() === '# 效果描述映射');
      const descriptionsStart = lines.findIndex((line, index) => index > descriptionsMarker && line.trim().startsWith('EFFECT_DESCRIPTIONS'));
      const termsStart = lines.findIndex((line, index) => index > descriptionsStart && line.trim().startsWith('# 效果术语映射'));
      if (classStart < 0 || descriptionsMarker < 0 || descriptionsStart < 0 || termsStart < 0) {
        throw new Error(tr('effects.py has an incomplete structure and cannot be written safely'));
      }
      const findCategory = (category: string, start: number, end: number) => {
        const marker = `# ${category}`;
        for (let index = start + 1; index < end; index++) {
          if (lines[index].trim() === marker) return index;
        }
        return -1;
      };
      const insertAtCategoryEnd = (categoryLine: number, end: number, newLine: string) => {
        let boundary = end;
        for (let index = categoryLine + 1; index < end; index++) {
          if (/^\s{4}#\s+/.test(lines[index])) {
            boundary = index;
            break;
          }
        }
        let insertAt = boundary;
        while (insertAt > categoryLine + 1 && lines[insertAt - 1].trim() === '') insertAt--;
        lines.splice(insertAt, 0, newLine);
      };
      if (action === 'addCategory') {
        const category = requiredString(data.category, tr('Effect category'));
        if (/[\r\n#]/.test(category)) throw new Error(tr('Effect category cannot contain line breaks or #'));
        if (findCategory(category, classStart, descriptionsMarker) >= 0) {
          throw new Error(tr('Effect category “{category}” already exists', { category }));
        }
        let enumInsert = descriptionsMarker;
        while (enumInsert > classStart + 1 && lines[enumInsert - 1].trim() === '') enumInsert--;
        lines.splice(enumInsert, 0, '', `    # ${category}`);
        const shiftedTermsStart = lines.findIndex((line, index) => index > descriptionsStart && line.trim().startsWith('# 效果术语映射'));
        let mapEnd = -1;
        for (let index = shiftedTermsStart - 1; index > descriptionsStart; index--) {
          if (lines[index].trim() === '}') {
            mapEnd = index;
            break;
          }
        }
        if (mapEnd < 0) throw new Error(tr('Unable to locate the closing brace of EFFECT_DESCRIPTIONS'));
        let mapInsert = mapEnd;
        while (mapInsert > descriptionsStart + 1 && lines[mapInsert - 1].trim() === '') mapInsert--;
        lines.splice(mapInsert, 0, '', `    # ${category}`);
      } else if (action === 'addEffect') {
        const effectId = requiredString(data.effectId, tr('Effect ID')).toUpperCase();
        const description = requiredString(data.description, tr('Effect description'));
        const category = requiredString(data.category, tr('Effect category'));
        if (!/^[A-Z][A-Z0-9_]*$/.test(effectId)) throw new Error(tr('Effect ID may contain only uppercase letters, digits, and underscores'));
        if (new RegExp(`^\\s*${effectId}\\s*=`, 'm').test(text)) throw new Error(tr('Effect {id} already exists', { id: effectId }));
        const enumCategory = findCategory(category, classStart, descriptionsMarker);
        if (enumCategory < 0) throw new Error(tr('Effect category “{category}” does not exist; add the category first', { category }));
        insertAtCategoryEnd(enumCategory, descriptionsMarker, `    ${effectId} = "${effectId}"`);
        const currentDescriptionsStart = lines.findIndex((line) => line.trim().startsWith('EFFECT_DESCRIPTIONS'));
        const currentTermsStart = lines.findIndex((line, index) => index > currentDescriptionsStart && line.trim().startsWith('# 效果术语映射'));
        let currentMapEnd = -1;
        for (let index = currentTermsStart - 1; index > currentDescriptionsStart; index--) {
          if (lines[index].trim() === '}') {
            currentMapEnd = index;
            break;
          }
        }
        if (currentMapEnd < 0) throw new Error(tr('Unable to locate the closing brace of EFFECT_DESCRIPTIONS'));
        const mapCategory = findCategory(category, currentDescriptionsStart, currentMapEnd);
        if (mapCategory < 0) throw new Error(tr('Unable to locate the description mapping group for “{category}”', { category }));
        const escapedDescription = JSON.stringify(description);
        insertAtCategoryEnd(mapCategory, currentMapEnd, `    EffectType.${effectId}: ${escapedDescription},`);
      } else {
        throw new Error(tr('Unsupported effect action: {action}', { action }));
      }
      text = lines.join(eol);
      this.atomicWriteText(file, text);
      await this.panel.webview.postMessage({ type: 'mutationResult', ok: true, action });
      await this.update(false);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      await this.panel.webview.postMessage({ type: 'mutationResult', ok: false, text });
      void vscode.window.showErrorMessage(tr('Failed to save effect data: {error}', { error: text }));
    }
  }

  private async update(forceWatcher = false): Promise<void> {
    if (this.disposed) return;
    const generation = ++this.generation;
    const projectDir = resolveProjectDir();
    if (!projectDir || !fs.existsSync(projectDir)) {
      this.projectDir = '';
      this.sources = undefined;
      this.disposeWatchers();
      await this.panel.webview.postMessage({
        type: 'error',
        text: tr('No character data project was found. Configure okScriptToolkit.characterProjectPath or okScriptToolkit.okScriptProjectPath.'),
      });
      return;
    }

    await this.panel.webview.postMessage({ type: 'loading', projectDir });
    let result: CharacterDataLoadResult;
    try {
      result = loadCharacterManagerData(configuredPaths(projectDir));
    } catch (error) {
      if (generation !== this.generation) return;
      await this.panel.webview.postMessage({
        type: 'error',
        text: tr('Failed to load character data: {error}', { error: error instanceof Error ? error.message : String(error) }),
      });
      return;
    }
    if (generation !== this.generation || this.disposed) return;
    this.projectDir = projectDir;
    this.sources = result.sources;
    const features = samePath(this.dependencies.features.root, projectDir)
      ? this.dependencies.features
      : this.projectFeatures?.root === projectDir
        ? this.projectFeatures
        : new FeatureData(projectDir);
    this.projectFeatures = features;
    if (forceWatcher) {
      this.invalidateAvatarThumbs(features);
      features.refresh(true);
    }
    const avatars = await this.characterAvatars(result, features);
    if (generation !== this.generation || this.disposed) return;
    if (forceWatcher || !this.watcherDisposables.length) this.recreateWatchers(configuredPaths(projectDir));
    await this.panel.webview.postMessage({ type: 'data', snapshot: result.snapshot, avatars });
  }

  private async characterAvatars(result: CharacterDataLoadResult, features: FeatureData): Promise<Record<string, string>> {
    const templates = avatarTemplateIndex(features);
    const avatars: Record<string, string> = {};
    const selected: Array<{ characterId: string; template: FeatureTemplate }> = [];
    for (const character of result.snapshot.characters) {
      const candidates = [character.master?.en, character.characterId];
      let template: FeatureTemplate | undefined;
      for (const candidate of candidates) {
        const key = normalizedAvatarKey(candidate);
        template = templates.byKey.get(key);
        if (!template && key) {
          const suffixMatches = templates.matched.filter((item) => normalizedAvatarKey(item.name).endsWith(key));
          if (suffixMatches.length === 1) template = suffixMatches[0];
        }
        if (template) break;
      }
      if (!template) continue;
      selected.push({ characterId: character.characterId, template });
    }
    const missing = selected.filter(({ template }) => {
      const file = templateThumbFilePath(template.imagePath, template.bbox, this.dependencies.thumbDir, THUMB_HEIGHT);
      try {
        return !fs.existsSync(file) || fs.statSync(file).size <= 0;
      } catch {
        return true;
      }
    });
    await warmCropCache(missing.map(({ template }) => ({
      imagePath: template.imagePath,
      bbox: template.bbox,
      targetHeight: THUMB_HEIGHT,
      thumbDir: this.dependencies.thumbDir,
    })));
    for (const { characterId, template } of selected) {
      const file = await cropTemplateThumbFileAsync(template.imagePath, template.bbox, this.dependencies.thumbDir, THUMB_HEIGHT);
      if (file) avatars[characterId] = this.panel.webview.asWebviewUri(vscode.Uri.file(file)).toString(true);
    }
    return avatars;
  }

  private invalidateAvatarThumbs(features: FeatureData): void {
    clearCropCache();
    for (const template of avatarTemplateIndex(features).matched) {
      removeTemplateThumbFile(template.imagePath, template.bbox, this.dependencies.thumbDir, THUMB_HEIGHT);
    }
  }

  private recreateWatchers(paths: CharacterDataPaths): void {
    this.disposeWatchers();
    const schedule = (refreshAvatars = false) => {
      if (refreshAvatars) this.avatarRefreshPending = true;
      if (this.refreshTimer) clearTimeout(this.refreshTimer);
      this.refreshTimer = setTimeout(() => {
        if (this.avatarRefreshPending) {
          this.avatarRefreshPending = false;
          if (this.projectFeatures) this.invalidateAvatarThumbs(this.projectFeatures);
          this.projectFeatures?.refresh(true);
        }
        void this.update(false);
      }, 350);
    };
    const watch = (base: string, pattern: string, refreshAvatars = false) => {
      if (!fs.existsSync(base)) return;
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(base, pattern));
      watcher.onDidChange(() => schedule(refreshAvatars));
      watcher.onDidCreate(() => schedule(refreshAvatars));
      watcher.onDidDelete(() => schedule(refreshAvatars));
      this.watcherDisposables.push(watcher);
    };
    watch(path.dirname(paths.masterFile), path.basename(paths.masterFile));
    watch(paths.skillsDir, '*.json');
    watch(path.dirname(paths.localeFile), path.basename(paths.localeFile));
    watch(path.dirname(paths.effectsFile), path.basename(paths.effectsFile));
    watch(path.dirname(paths.effectNamesFile), path.basename(paths.effectNamesFile));
    if (!samePath(paths.projectDir, this.dependencies.features.root)) {
      for (const relative of ['assets', 'ok_tasks/assets']) {
        const assetDir = path.join(paths.projectDir, relative);
        watch(assetDir, 'coco_annotations.json', true);
        watch(path.join(assetDir, 'images'), '*.png', true);
      }
    }
  }

  private disposeWatchers(): void {
    for (const disposable of this.watcherDisposables) disposable.dispose();
    this.watcherDisposables = [];
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    this.avatarRefreshPending = false;
  }

  private sourceFor(message: CharacterManagerMessage): string | undefined {
    if (!this.sources) return undefined;
    switch (message.kind) {
      case 'character':
        if (message.characterId) return this.sources.characterFiles.get(message.characterId);
        if (message.fileName) return this.sources.characterFilesByName.get(message.fileName);
        return undefined;
      case 'master':
        return this.sources.masterFile;
      case 'locale':
        return this.sources.localeFile;
      case 'effects':
        return this.sources.effectsFile;
      default:
        return undefined;
    }
  }

  private async openSource(message: CharacterManagerMessage): Promise<void> {
    const file = this.sourceFor(message);
    if (!file || !fs.existsSync(file)) {
      void vscode.window.showWarningMessage(tr('The corresponding source file could not be found.'));
      return;
    }
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    const editor = await vscode.window.showTextDocument(document, { preview: false, viewColumn: vscode.ViewColumn.Beside });
    const needle = message.skillId || message.effectId || message.characterId;
    if (!needle) return;
    const text = document.getText();
    const offset = text.indexOf(`"${needle}"`);
    if (offset < 0) return;
    const position = document.positionAt(offset);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    this.disposeWatchers();
    for (const disposable of this.disposables) disposable.dispose();
    this.disposables.length = 0;
    if (CharacterManagerPanel.current === this) CharacterManagerPanel.current = undefined;
  }
}

/** 侧边栏中的单按钮入口；大面板仍在编辑器区打开。 */
export class CharacterManagerLauncherViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'okScriptToolkit.toolbox';

  constructor(private readonly dependencies: CharacterManagerDependencies) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = { enableScripts: true };
    const nonce = getNonce();
    const strings = JSON.stringify(webviewStrings()).replace(/</g, '\\u003c');
    view.webview.html = `<!DOCTYPE html>
<html lang="zh-cn">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'">
<style>
  body {
    margin: 0;
    padding: 10px 12px;
    color: var(--vscode-sideBar-foreground);
    background: var(--vscode-sideBar-background);
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size, 13px);
  }
  button {
    width: 100%;
    border: none;
    border-radius: 3px;
    padding: 7px 10px;
    cursor: pointer;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    font: inherit;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
</style>
</head>
<body>
  <button id="open"></button>
  <script nonce="${nonce}">
    const I18N = ${strings};
    const vscode = acquireVsCodeApi();
    document.getElementById('open').textContent = I18N.toolboxOpenCharacterManager;
    document.getElementById('open').addEventListener('click', () => vscode.postMessage({ type: 'open' }));
  </script>
</body>
</html>`;
    view.webview.onDidReceiveMessage((message: { type?: string }) => {
      if (message.type === 'open') CharacterManagerPanel.show(this.dependencies);
    });
  }
}
