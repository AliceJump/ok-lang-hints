import * as fs from 'fs';
import * as path from 'path';
import { parseEffects } from './effectData';

export type CharacterIssueSeverity = 'error' | 'warning' | 'info';
export type CharacterSourceKind = 'character' | 'master' | 'locale' | 'effects';

export interface CharacterIssueSource {
  kind: CharacterSourceKind;
  characterId?: string;
  skillId?: string;
  effectId?: string;
  fileName?: string;
}

export interface CharacterIssue {
  id: string;
  severity: CharacterIssueSeverity;
  code: string;
  message: string;
  source?: CharacterIssueSource;
}

export interface CharacterEffectRef {
  effectId: string;
  value?: unknown;
  duration?: unknown;
  target?: string;
  count?: number;
  inferred?: boolean;
  known: boolean;
}

export interface CharacterEnhancementView {
  name: string;
  triggerText: string;
  triggerEffects: CharacterEffectRef[];
  effects: CharacterEffectRef[];
  enhancementEffect: string;
  visiblePulse: boolean;
}

export interface CharacterSkillView {
  skillId: string;
  name: string;
  skillType: string;
  element: string;
  description: string;
  damageMultiplier: string;
  staggerValue: number;
  cooldown: string;
  spiritCost: number;
  hasEnhancement: boolean;
  effects: CharacterEffectRef[];
  enhancements: CharacterEnhancementView[];
}

export interface CharacterMasterView {
  key: string;
  zh: string;
  en: string;
  stars: number;
}

export interface CharacterView {
  characterId: string;
  name: string;
  star: number;
  element: string;
  profession: string;
  weaponType: string;
  wikiItemId: string;
  sourceFile?: string;
  master?: CharacterMasterView;
  locales: Record<string, string>;
  skills: CharacterSkillView[];
  issueCount: number;
  errorCount: number;
}

export type EffectUsageScope = 'skill' | 'enhancement-trigger' | 'enhancement-effect';

export interface CharacterEffectUsage {
  characterId: string;
  characterName: string;
  skillId: string;
  skillName: string;
  skillType: string;
  scope: EffectUsageScope;
  enhancementName?: string;
}

export interface CharacterEffectView {
  id: string;
  description: string;
  category: string;
  defined: boolean;
  usages: CharacterEffectUsage[];
}

export interface CharacterDataSummary {
  masterCharacters: number;
  skillFiles: number;
  characters: number;
  skills: number;
  enhancements: number;
  effectReferences: number;
  definedEffects: number;
  unknownEffects: number;
  errors: number;
  warnings: number;
  infos: number;
  locales: string[];
}

export interface CharacterManagerSnapshot {
  projectDir: string;
  loadedAt: string;
  characters: CharacterView[];
  effects: CharacterEffectView[];
  issues: CharacterIssue[];
  summary: CharacterDataSummary;
}

export interface CharacterDataPaths {
  projectDir: string;
  masterFile: string;
  skillsDir: string;
  localeFile: string;
  effectsFile: string;
}

export interface CharacterDataSources {
  masterFile: string;
  localeFile: string;
  effectsFile: string;
  characterFiles: Map<string, string>;
  characterFilesByName: Map<string, string>;
}

export interface CharacterDataLoadResult {
  snapshot: CharacterManagerSnapshot;
  sources: CharacterDataSources;
}

type JsonObject = Record<string, unknown>;

interface PendingUsage {
  effectId: string;
  usage: CharacterEffectUsage;
  source: CharacterIssueSource;
}

interface ParsedSkillCharacter {
  characterId: string;
  name: string;
  star: number;
  element: string;
  profession: string;
  weaponType: string;
  wikiItemId: string;
  sourceFile: string;
  skills: CharacterSkillView[];
}

const PREFERRED_LOCALES = [
  'zh_CN', 'zh_TW', 'en_US', 'ja_JP', 'ko_KR', 'es_ES',
  'de_DE', 'fr_FR', 'it_IT', 'pt_BR', 'ru_RU', 'id_ID', 'th_TH', 'vi_VN',
];

function isObject(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function booleanValue(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function readJsonObject(
  file: string,
  issues: CharacterIssue[],
  addIssue: (severity: CharacterIssueSeverity, code: string, message: string, source?: CharacterIssueSource) => void,
  source: CharacterIssueSource,
): JsonObject | undefined {
  if (!fs.existsSync(file)) {
    addIssue('error', 'missing-file', `找不到数据文件：${file}`, source);
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!isObject(parsed)) {
      addIssue('error', 'invalid-root', `JSON 顶层必须是对象：${file}`, source);
      return undefined;
    }
    return parsed;
  } catch (error) {
    addIssue(
      'error',
      'invalid-json',
      `JSON 解析失败：${file} · ${error instanceof Error ? error.message : String(error)}`,
      source,
    );
    return undefined;
  }
}

function parseEffectTermMap(text: string): Map<string, string> {
  const result = new Map<string, string>();
  const re = /^\s*"([^"]+)"\s*:\s*EffectType\.([A-Z][A-Z0-9_]+)\s*,?\s*$/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) result.set(match[1], match[2]);
  return result;
}

function inferEffectIds(text: string, terms: Map<string, string>): string[] {
  if (!text) return [];
  const sorted = [...terms.entries()].sort((a, b) => b[0].length - a[0].length);
  const result: string[] = [];
  let offset = 0;
  while (offset < text.length) {
    let found: [string, string] | undefined;
    for (const entry of sorted) {
      if (text.startsWith(entry[0], offset)) {
        found = entry;
        break;
      }
    }
    if (!found) {
      offset++;
      continue;
    }
    if (!result.includes(found[1])) result.push(found[1]);
    offset += found[0].length;
  }
  return result;
}

function effectIdFromUnknown(value: unknown): string {
  if (typeof value === 'string') return value;
  if (isObject(value)) return stringValue(value['effect_id']);
  return '';
}

export function loadCharacterManagerData(paths: CharacterDataPaths): CharacterDataLoadResult {
  const issues: CharacterIssue[] = [];
  let issueIndex = 0;
  const addIssue = (
    severity: CharacterIssueSeverity,
    code: string,
    message: string,
    source?: CharacterIssueSource,
  ) => {
    issues.push({ id: `${code}-${++issueIndex}`, severity, code, message, source });
  };

  const sources: CharacterDataSources = {
    masterFile: paths.masterFile,
    localeFile: paths.localeFile,
    effectsFile: paths.effectsFile,
    characterFiles: new Map(),
    characterFilesByName: new Map(),
  };

  const masterById = new Map<string, CharacterMasterView>();
  const master = readJsonObject(paths.masterFile, issues, addIssue, { kind: 'master' });
  if (master) {
    for (const [key, raw] of Object.entries(master)) {
      if (!isObject(raw)) {
        addIssue('warning', 'invalid-master-entry', `角色主表 ${key} 不是对象`, { kind: 'master', characterId: key });
        continue;
      }
      const zh = stringValue(raw['zh']);
      const en = stringValue(raw['en']);
      const stars = numberValue(raw['stars']);
      if (!zh) addIssue('warning', 'missing-master-name', `角色主表 ${key} 缺少 zh 名称`, { kind: 'master', characterId: key });
      masterById.set(key, { key, zh, en, stars });
    }
  }

  const localeById = new Map<string, Record<string, string>>();
  const localeNames = new Set<string>();
  const localeRoot = readJsonObject(paths.localeFile, issues, addIssue, { kind: 'locale' });
  if (localeRoot) {
    for (const [characterId, rawLocales] of Object.entries(localeRoot)) {
      if (!isObject(rawLocales)) continue;
      const localized: Record<string, string> = {};
      for (const [locale, rawNode] of Object.entries(rawLocales)) {
        if (!isObject(rawNode)) continue;
        const value = stringValue(rawNode['string']) || stringValue(rawNode['pattern']);
        if (value) {
          localized[locale] = value;
          localeNames.add(locale);
        }
      }
      localeById.set(characterId, localized);
    }
  }

  let effectsText = '';
  if (fs.existsSync(paths.effectsFile)) {
    try {
      effectsText = fs.readFileSync(paths.effectsFile, 'utf-8');
    } catch (error) {
      addIssue('error', 'effects-read-error', `无法读取效果定义：${error instanceof Error ? error.message : String(error)}`, { kind: 'effects' });
    }
  } else {
    addIssue('error', 'missing-effects-file', `找不到效果定义：${paths.effectsFile}`, { kind: 'effects' });
  }
  const effectDefinitions = parseEffects(effectsText);
  const effectTerms = parseEffectTermMap(effectsText);
  const pendingUsages: PendingUsage[] = [];
  let effectReferenceCount = 0;

  const normalizeEffect = (
    raw: unknown,
    usage: CharacterEffectUsage,
    source: CharacterIssueSource,
    inferred = false,
  ): CharacterEffectRef | undefined => {
    const effectId = effectIdFromUnknown(raw);
    if (!effectId) {
      addIssue('warning', 'missing-effect-id', `${usage.characterName} / ${usage.skillName} 存在缺少 effect_id 的效果项`, source);
      return undefined;
    }
    const object = isObject(raw) ? raw : {};
    const ref: CharacterEffectRef = {
      effectId,
      known: effectDefinitions.has(effectId),
      inferred,
    };
    if ('value' in object) ref.value = object['value'];
    if ('duration' in object) ref.duration = object['duration'];
    if (typeof object['target'] === 'string') ref.target = object['target'];
    if (typeof object['count'] === 'number') ref.count = object['count'];
    pendingUsages.push({ effectId, usage, source });
    effectReferenceCount++;
    return ref;
  };

  const parsedById = new Map<string, ParsedSkillCharacter>();
  const globalSkillIds = new Map<string, { characterId: string; characterName: string; sourceFile: string }>();
  let skillFileCount = 0;
  let skillCount = 0;
  let enhancementCount = 0;

  if (!fs.existsSync(paths.skillsDir)) {
    addIssue('error', 'missing-skills-directory', `找不到角色技能目录：${paths.skillsDir}`, { kind: 'character' });
  } else {
    let files: string[] = [];
    try {
      files = fs.readdirSync(paths.skillsDir).filter((name) => name.toLowerCase().endsWith('.json')).sort();
    } catch (error) {
      addIssue('error', 'skills-directory-read-error', `无法读取角色技能目录：${error instanceof Error ? error.message : String(error)}`, { kind: 'character' });
    }

    for (const fileName of files) {
      const file = path.join(paths.skillsDir, fileName);
      const raw = readJsonObject(file, issues, addIssue, { kind: 'character', fileName });
      if (!raw) continue;
      skillFileCount++;
      let characterId = stringValue(raw['character_id']);
      if (!characterId) {
        characterId = path.basename(fileName, path.extname(fileName));
        addIssue('error', 'missing-character-id', `${fileName} 缺少 character_id，暂用文件名 ${characterId}`, { kind: 'character', characterId, fileName });
      }
      const characterName = stringValue(raw['name'], masterById.get(characterId)?.zh || characterId);
      const source: CharacterIssueSource = { kind: 'character', characterId, fileName };
      if (parsedById.has(characterId)) {
        addIssue('error', 'duplicate-character-id', `重复的角色技能 character_id：${characterId}`, source);
        continue;
      }
      sources.characterFiles.set(characterId, file);
      sources.characterFilesByName.set(fileName, file);

      const rawSkills = Array.isArray(raw['skills']) ? raw['skills'] : [];
      if (!Array.isArray(raw['skills'])) addIssue('warning', 'missing-skills-array', `${characterName} 缺少 skills 数组`, source);
      const skills: CharacterSkillView[] = [];

      for (let skillIndex = 0; skillIndex < rawSkills.length; skillIndex++) {
        const rawSkill = rawSkills[skillIndex];
        if (!isObject(rawSkill)) {
          addIssue('warning', 'invalid-skill-entry', `${characterName} 的第 ${skillIndex + 1} 个技能不是对象`, source);
          continue;
        }
        let skillId = stringValue(rawSkill['skill_id']);
        if (!skillId) {
          skillId = `${characterId}_skill_${skillIndex + 1}`;
          addIssue('error', 'missing-skill-id', `${characterName} 的第 ${skillIndex + 1} 个技能缺少 skill_id`, { ...source, skillId });
        }
        const skillName = stringValue(rawSkill['name'], skillId);
        const skillType = stringValue(rawSkill['skill_type'], '未分类');
        const skillSource: CharacterIssueSource = { ...source, skillId };
        const duplicate = globalSkillIds.get(skillId);
        if (duplicate) {
          addIssue('error', 'duplicate-skill-id', `技能 ID ${skillId} 同时用于 ${duplicate.characterName} 和 ${characterName}`, skillSource);
        } else {
          globalSkillIds.set(skillId, { characterId, characterName, sourceFile: fileName });
        }

        const baseUsage = (scope: EffectUsageScope, enhancementName?: string): CharacterEffectUsage => ({
          characterId,
          characterName,
          skillId,
          skillName,
          skillType,
          scope,
          enhancementName,
        });

        const effects: CharacterEffectRef[] = [];
        const seenBaseEffects = new Set<string>();
        const rawEffects = Array.isArray(rawSkill['effects']) ? rawSkill['effects'] : [];
        for (const rawEffect of rawEffects) {
          const ref = normalizeEffect(rawEffect, baseUsage('skill'), skillSource);
          if (ref) {
            effects.push(ref);
            seenBaseEffects.add(ref.effectId);
          }
        }
        for (const legacyKey of ['attach_effects', 'status_effects', 'clear_effects']) {
          const legacy = Array.isArray(rawSkill[legacyKey]) ? rawSkill[legacyKey] as unknown[] : [];
          for (const rawEffect of legacy) {
            const effectId = effectIdFromUnknown(rawEffect);
            if (!effectId || seenBaseEffects.has(effectId)) continue;
            const ref = normalizeEffect(rawEffect, baseUsage('skill'), skillSource);
            if (ref) {
              effects.push(ref);
              seenBaseEffects.add(ref.effectId);
            }
          }
        }

        const rawEnhancements = Array.isArray(rawSkill['enhancements']) && rawSkill['enhancements'].length
          ? rawSkill['enhancements'] as unknown[]
          : isObject(rawSkill['enhancement'])
            ? [rawSkill['enhancement']]
            : [];
        const enhancements: CharacterEnhancementView[] = [];
        for (let enhancementIndex = 0; enhancementIndex < rawEnhancements.length; enhancementIndex++) {
          const rawEnhancement = rawEnhancements[enhancementIndex];
          if (!isObject(rawEnhancement)) continue;
          const enhancementName = stringValue(rawEnhancement['name'], `强化 ${enhancementIndex + 1}`);
          const triggerRaw = rawEnhancement['trigger_condition'];
          let triggerText = '';
          let triggerIds: string[] = [];
          if (typeof triggerRaw === 'string') {
            triggerText = triggerRaw;
          } else if (isObject(triggerRaw)) {
            triggerText = stringValue(triggerRaw['text']);
            if (Array.isArray(triggerRaw['effects'])) {
              triggerIds = triggerRaw['effects'].map(effectIdFromUnknown).filter(Boolean);
            }
          }
          let inferred = false;
          if (!triggerIds.length && triggerText) {
            triggerIds = inferEffectIds(triggerText, effectTerms);
            inferred = triggerIds.length > 0;
          }
          const triggerEffects = triggerIds
            .map((effectId) => normalizeEffect(effectId, baseUsage('enhancement-trigger', enhancementName), skillSource, inferred))
            .filter((ref): ref is CharacterEffectRef => !!ref);
          const enhancementEffects = (Array.isArray(rawEnhancement['effects']) ? rawEnhancement['effects'] : [])
            .map((rawEffect) => normalizeEffect(rawEffect, baseUsage('enhancement-effect', enhancementName), skillSource))
            .filter((ref): ref is CharacterEffectRef => !!ref);
          enhancements.push({
            name: enhancementName,
            triggerText,
            triggerEffects,
            effects: enhancementEffects,
            enhancementEffect: stringValue(rawEnhancement['enhancement_effect']),
            visiblePulse: booleanValue(rawEnhancement['enhancement_visible_pulse']),
          });
          enhancementCount++;
        }

        const hasEnhancement = booleanValue(rawSkill['has_enhancement'], enhancements.length > 0);
        if (hasEnhancement && !enhancements.length) {
          addIssue('warning', 'missing-enhancement-data', `${characterName} / ${skillName} 标记 has_enhancement=true，但没有强化组数据`, skillSource);
        }
        if (!hasEnhancement && enhancements.length) {
          addIssue('warning', 'unexpected-enhancement-data', `${characterName} / ${skillName} 有强化组数据，但 has_enhancement=false`, skillSource);
        }

        skills.push({
          skillId,
          name: skillName,
          skillType,
          element: stringValue(rawSkill['element'], stringValue(raw['element'])),
          description: stringValue(rawSkill['description']),
          damageMultiplier: rawSkill['damage_multiplier'] == null ? '' : String(rawSkill['damage_multiplier']),
          staggerValue: numberValue(rawSkill['stagger_value']),
          cooldown: rawSkill['cooldown'] == null ? '' : String(rawSkill['cooldown']),
          spiritCost: numberValue(rawSkill['spirit_cost']),
          hasEnhancement,
          effects,
          enhancements,
        });
        skillCount++;
      }

      parsedById.set(characterId, {
        characterId,
        name: characterName,
        star: numberValue(raw['star']),
        element: stringValue(raw['element']),
        profession: stringValue(raw['profession']),
        weaponType: stringValue(raw['weapon_type']),
        wikiItemId: raw['wiki_item_id'] == null ? '' : String(raw['wiki_item_id']),
        sourceFile: fileName,
        skills,
      });
    }
  }

  const allCharacterIds = new Set<string>([...masterById.keys(), ...parsedById.keys()]);
  const characters: CharacterView[] = [];
  for (const characterId of allCharacterIds) {
    const masterInfo = masterById.get(characterId);
    const parsed = parsedById.get(characterId);
    const source: CharacterIssueSource = { kind: 'character', characterId, fileName: parsed?.sourceFile };
    if (!parsed) addIssue('warning', 'missing-skill-file', `角色主表 ${masterInfo?.zh || characterId} 没有对应的技能文件`, { kind: 'master', characterId });
    if (!masterInfo) addIssue('warning', 'missing-master-entry', `技能角色 ${parsed?.name || characterId} 不在 characters.json 主表中`, source);
    if (masterInfo && parsed) {
      if (masterInfo.zh && parsed.name && masterInfo.zh !== parsed.name) {
        addIssue('warning', 'character-name-mismatch', `${characterId} 的主表名称“${masterInfo.zh}”与技能文件名称“${parsed.name}”不一致`, source);
      }
      if (masterInfo.stars && parsed.star && masterInfo.stars !== parsed.star) {
        addIssue('warning', 'character-star-mismatch', `${parsed.name} 的主表星级 ${masterInfo.stars} 与技能文件星级 ${parsed.star} 不一致`, source);
      }
    }
    const locales = localeById.get(characterId) || {};
    if (!Object.keys(locales).length) addIssue('warning', 'missing-character-locales', `${parsed?.name || masterInfo?.zh || characterId} 缺少多语言名称`, { kind: 'locale', characterId });
    const related = issues.filter((issue) => issue.source?.characterId === characterId);
    characters.push({
      characterId,
      name: parsed?.name || masterInfo?.zh || characterId,
      star: parsed?.star || masterInfo?.stars || 0,
      element: parsed?.element || '',
      profession: parsed?.profession || '',
      weaponType: parsed?.weaponType || '',
      wikiItemId: parsed?.wikiItemId || '',
      sourceFile: parsed?.sourceFile,
      master: masterInfo,
      locales,
      skills: parsed?.skills || [],
      issueCount: related.length,
      errorCount: related.filter((issue) => issue.severity === 'error').length,
    });
  }

  for (const localeCharacterId of localeById.keys()) {
    if (!allCharacterIds.has(localeCharacterId)) {
      addIssue('info', 'orphan-locale-entry', `多语言名称 ${localeCharacterId} 没有角色主表或技能文件`, { kind: 'locale', characterId: localeCharacterId });
    }
  }

  const effectViews = new Map<string, CharacterEffectView>();
  for (const entry of effectDefinitions.values()) {
    effectViews.set(entry.id, {
      id: entry.id,
      description: entry.description,
      category: entry.category,
      defined: true,
      usages: [],
    });
  }
  const unknownEffectIds = new Set<string>();
  for (const pending of pendingUsages) {
    let effect = effectViews.get(pending.effectId);
    if (!effect) {
      effect = {
        id: pending.effectId,
        description: '未在 effects.py 中定义',
        category: '未定义',
        defined: false,
        usages: [],
      };
      effectViews.set(pending.effectId, effect);
      unknownEffectIds.add(pending.effectId);
      addIssue('error', 'unknown-effect-id', `${pending.usage.characterName} / ${pending.usage.skillName} 引用了未知效果 ${pending.effectId}`, pending.source);
    }
    effect.usages.push(pending.usage);
  }

  for (const character of characters) {
    const related = issues.filter((issue) => issue.source?.characterId === character.characterId);
    character.issueCount = related.length;
    character.errorCount = related.filter((issue) => issue.severity === 'error').length;
  }

  const localeOrder = [...localeNames].sort((a, b) => {
    const ai = PREFERRED_LOCALES.indexOf(a);
    const bi = PREFERRED_LOCALES.indexOf(b);
    if (ai >= 0 || bi >= 0) return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi);
    return a.localeCompare(b);
  });
  characters.sort((a, b) => b.star - a.star || a.name.localeCompare(b.name));
  const effects = [...effectViews.values()].sort((a, b) => {
    if (a.defined !== b.defined) return a.defined ? 1 : -1;
    return a.category.localeCompare(b.category) || a.id.localeCompare(b.id);
  });
  issues.sort((a, b) => {
    const rank: Record<CharacterIssueSeverity, number> = { error: 0, warning: 1, info: 2 };
    return rank[a.severity] - rank[b.severity] || a.message.localeCompare(b.message);
  });

  const snapshot: CharacterManagerSnapshot = {
    projectDir: paths.projectDir,
    loadedAt: new Date().toISOString(),
    characters,
    effects,
    issues,
    summary: {
      masterCharacters: masterById.size,
      skillFiles: skillFileCount,
      characters: characters.length,
      skills: skillCount,
      enhancements: enhancementCount,
      effectReferences: effectReferenceCount,
      definedEffects: effectDefinitions.size,
      unknownEffects: unknownEffectIds.size,
      errors: issues.filter((issue) => issue.severity === 'error').length,
      warnings: issues.filter((issue) => issue.severity === 'warning').length,
      infos: issues.filter((issue) => issue.severity === 'info').length,
      locales: localeOrder,
    },
  };
  return { snapshot, sources };
}

export function configuredCharacterDataPaths(
  projectDir: string,
  configured: {
    masterFile?: string;
    skillsDirectory?: string;
    localeFile?: string;
    effectsFile?: string;
  } = {},
): CharacterDataPaths {
  const resolve = (value: string | undefined, fallback: string) => {
    const selected = value?.trim() || fallback;
    return path.isAbsolute(selected) ? selected : path.join(projectDir, selected);
  };
  return {
    projectDir,
    masterFile: resolve(configured.masterFile, 'assets/data/characters.json'),
    skillsDir: resolve(configured.skillsDirectory, 'assets/data/character_skills'),
    localeFile: resolve(configured.localeFile, 'assets/lang/characters.json'),
    effectsFile: resolve(configured.effectsFile, 'src/data/effects.py'),
  };
}
