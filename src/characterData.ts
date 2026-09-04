import * as fs from 'fs';
import * as path from 'path';
import { parseEffects } from './effectData';
import { projectLocale, tr } from './localization';

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
  displayName: string;
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
  triggerEffectMode: 'all' | 'any';
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
  /** 仅面板新增的技能为 custom；同步技能的 ID/类别不可修改且不可删除。 */
  source: 'synced' | 'custom';
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
  displayName: string;
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
  effectCategories: string[];
  issues: CharacterIssue[];
  summary: CharacterDataSummary;
}

export interface CharacterDataPaths {
  projectDir: string;
  masterFile: string;
  skillsDir: string;
  localeFile: string;
  effectsFile: string;
  effectNamesFile: string;
}

export interface CharacterDataSources {
  masterFile: string;
  localeFile: string;
  effectsFile: string;
  effectNamesFile: string;
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

function readEffectNames(file: string): Map<string, string> {
  const result = new Map<string, string>();
  if (!fs.existsSync(file)) return result;
  let root: unknown;
  try {
    root = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return result;
  }
  if (!isObject(root)) return result;
  const locale = projectLocale();
  const fallbackLocales = [...new Set([locale, 'zh_CN', 'en_US'])];
  for (const [effectId, rawLocales] of Object.entries(root)) {
    if (!isObject(rawLocales)) continue;
    let name = '';
    for (const candidate of fallbackLocales) {
      const node = rawLocales[candidate];
      if (!isObject(node)) continue;
      name = stringValue(node['string']) || stringValue(node['pattern']);
      if (name) break;
    }
    if (name) result.set(effectId, name);
  }
  return result;
}

function readJsonObject(
  file: string,
  issues: CharacterIssue[],
  addIssue: (severity: CharacterIssueSeverity, code: string, message: string, source?: CharacterIssueSource) => void,
  source: CharacterIssueSource,
): JsonObject | undefined {
  if (!fs.existsSync(file)) {
    addIssue('error', 'missing-file', tr('Data file not found: {path}', { path: file }), source);
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!isObject(parsed)) {
      addIssue('error', 'invalid-root', tr('The JSON root must be an object: {path}', { path: file }), source);
      return undefined;
    }
    return parsed;
  } catch (error) {
    addIssue(
      'error',
      'invalid-json',
      tr('Failed to parse JSON: {path} · {error}', {
        path: file,
        error: error instanceof Error ? error.message : String(error),
      }),
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

function parseEffectCategories(text: string): string[] {
  const classStart = text.indexOf('class EffectType');
  const classEnd = text.indexOf('# 效果描述映射', classStart);
  if (classStart < 0 || classEnd < 0) return [];
  const section = text.slice(classStart, classEnd);
  const result: string[] = [];
  const re = /^\s{4}#\s*(.+?)\s*$/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(section)) !== null) {
    const category = match[1].trim();
    if (category && !result.includes(category)) result.push(category);
  }
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
    effectNamesFile: paths.effectNamesFile,
    characterFiles: new Map(),
    characterFilesByName: new Map(),
  };

  const masterById = new Map<string, CharacterMasterView>();
  const master = readJsonObject(paths.masterFile, issues, addIssue, { kind: 'master' });
  if (master) {
    for (const [key, raw] of Object.entries(master)) {
      if (!isObject(raw)) {
        addIssue('warning', 'invalid-master-entry', tr('Character master entry {id} is not an object', { id: key }), { kind: 'master', characterId: key });
        continue;
      }
      const zh = stringValue(raw['zh']);
      const en = stringValue(raw['en']);
      const stars = numberValue(raw['stars']);
      if (!zh) addIssue('warning', 'missing-master-name', tr('Character master entry {id} is missing its zh name', { id: key }), { kind: 'master', characterId: key });
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
      addIssue('error', 'effects-read-error', tr('Unable to read effect definitions: {error}', { error: error instanceof Error ? error.message : String(error) }), { kind: 'effects' });
    }
  } else {
    addIssue('error', 'missing-effects-file', tr('Effect definition file not found: {path}', { path: paths.effectsFile }), { kind: 'effects' });
  }
  const effectDefinitions = parseEffects(effectsText);
  const effectNames = readEffectNames(paths.effectNamesFile);
  const effectCategories = parseEffectCategories(effectsText);
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
      addIssue('warning', 'missing-effect-id', tr('{character} / {skill} contains an effect entry without effect_id', {
        character: usage.characterName,
        skill: usage.skillName,
      }), source);
      return undefined;
    }
    const object = isObject(raw) ? raw : {};
    const ref: CharacterEffectRef = {
      effectId,
      displayName: effectNames.get(effectId) || effectDefinitions.get(effectId)?.description || effectId,
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
    addIssue('error', 'missing-skills-directory', tr('Character skill directory not found: {path}', { path: paths.skillsDir }), { kind: 'character' });
  } else {
    let files: string[] = [];
    try {
      files = fs.readdirSync(paths.skillsDir).filter((name) => name.toLowerCase().endsWith('.json')).sort();
    } catch (error) {
      addIssue('error', 'skills-directory-read-error', tr('Unable to read the character skill directory: {error}', { error: error instanceof Error ? error.message : String(error) }), { kind: 'character' });
    }

    for (const fileName of files) {
      const file = path.join(paths.skillsDir, fileName);
      const raw = readJsonObject(file, issues, addIssue, { kind: 'character', fileName });
      if (!raw) continue;
      skillFileCount++;
      let characterId = stringValue(raw['character_id']);
      if (!characterId) {
        characterId = path.basename(fileName, path.extname(fileName));
        addIssue('error', 'missing-character-id', tr('{file} is missing character_id; using file name {id}', { file: fileName, id: characterId }), { kind: 'character', characterId, fileName });
      }
      const characterName = stringValue(raw['name'], masterById.get(characterId)?.zh || characterId);
      const source: CharacterIssueSource = { kind: 'character', characterId, fileName };
      if (parsedById.has(characterId)) {
        addIssue('error', 'duplicate-character-id', tr('Duplicate character skill character_id: {id}', { id: characterId }), source);
        continue;
      }
      sources.characterFiles.set(characterId, file);
      sources.characterFilesByName.set(fileName, file);

      const rawSkills = Array.isArray(raw['skills']) ? raw['skills'] : [];
      if (!Array.isArray(raw['skills'])) addIssue('warning', 'missing-skills-array', tr('{character} is missing the skills array', { character: characterName }), source);
      const skills: CharacterSkillView[] = [];

      for (let skillIndex = 0; skillIndex < rawSkills.length; skillIndex++) {
        const rawSkill = rawSkills[skillIndex];
        if (!isObject(rawSkill)) {
          addIssue('warning', 'invalid-skill-entry', tr('Skill {index} for {character} is not an object', { character: characterName, index: skillIndex + 1 }), source);
          continue;
        }
        let skillId = stringValue(rawSkill['skill_id']);
        if (!skillId) {
          skillId = `${characterId}_skill_${skillIndex + 1}`;
          addIssue('error', 'missing-skill-id', tr('Skill {index} for {character} is missing skill_id', { character: characterName, index: skillIndex + 1 }), { ...source, skillId });
        }
        const skillName = stringValue(rawSkill['name'], skillId);
        const skillType = stringValue(rawSkill['skill_type'], tr('uncategorized'));
        const skillSource: CharacterIssueSource = { ...source, skillId };
        const duplicate = globalSkillIds.get(skillId);
        if (duplicate) {
          addIssue('error', 'duplicate-skill-id', tr('Skill ID {id} is used by both {first} and {second}', {
            id: skillId,
            first: duplicate.characterName,
            second: characterName,
          }), skillSource);
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
          const enhancementName = stringValue(rawEnhancement['name'], tr('enhancementFallbackName', { index: enhancementIndex + 1 }));
          const triggerRaw = rawEnhancement['trigger_condition'];
          let triggerText = '';
          let triggerIds: string[] = [];
          let triggerEffectMode: 'all' | 'any' = 'all';
          if (typeof triggerRaw === 'string') {
            triggerText = triggerRaw;
          } else if (isObject(triggerRaw)) {
            triggerText = stringValue(triggerRaw['text']);
            const rawTriggerEffects = triggerRaw['effects'];
            if (Array.isArray(rawTriggerEffects)) {
              triggerIds = rawTriggerEffects.map(effectIdFromUnknown).filter(Boolean);
            } else if (isObject(rawTriggerEffects)) {
              if (Array.isArray(rawTriggerEffects['all'])) {
                triggerIds = rawTriggerEffects['all'].map(effectIdFromUnknown).filter(Boolean);
                triggerEffectMode = 'all';
              } else if (Array.isArray(rawTriggerEffects['any'])) {
                triggerIds = rawTriggerEffects['any'].map(effectIdFromUnknown).filter(Boolean);
                triggerEffectMode = 'any';
              }
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
            triggerEffectMode,
            triggerEffects,
            effects: enhancementEffects,
            enhancementEffect: stringValue(rawEnhancement['enhancement_effect']),
            visiblePulse: booleanValue(rawEnhancement['enhancement_visible_pulse']),
          });
          enhancementCount++;
        }

        const hasEnhancement = booleanValue(rawSkill['has_enhancement'], enhancements.length > 0);
        if (hasEnhancement && !enhancements.length) {
          addIssue('warning', 'missing-enhancement-data', tr('{character} / {skill} sets has_enhancement=true but has no enhancement data', {
            character: characterName,
            skill: skillName,
          }), skillSource);
        }
        if (!hasEnhancement && enhancements.length) {
          addIssue('warning', 'unexpected-enhancement-data', tr('{character} / {skill} has enhancement data but sets has_enhancement=false', {
            character: characterName,
            skill: skillName,
          }), skillSource);
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
          source: rawSkill['_ok_lang_hints_custom'] === true ? 'custom' : 'synced',
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
    if (!parsed) addIssue('warning', 'missing-skill-file', tr('Character master entry {character} has no corresponding skill file', { character: masterInfo?.zh || characterId }), { kind: 'master', characterId });
    if (!masterInfo) addIssue('warning', 'missing-master-entry', tr('Skill character {character} is not present in the characters.json master table', { character: parsed?.name || characterId }), source);
    if (masterInfo && parsed) {
      if (masterInfo.zh && parsed.name && masterInfo.zh !== parsed.name) {
        addIssue('warning', 'character-name-mismatch', tr('Character {id} has master name “{master}” but skill-file name “{skillFile}”', {
          id: characterId,
          master: masterInfo.zh,
          skillFile: parsed.name,
        }), source);
      }
      if (masterInfo.stars && parsed.star && masterInfo.stars !== parsed.star) {
        addIssue('warning', 'character-star-mismatch', tr('{character} has master rarity {master} but skill-file rarity {skillFile}', {
          character: parsed.name,
          master: masterInfo.stars,
          skillFile: parsed.star,
        }), source);
      }
    }
    const locales = localeById.get(characterId) || {};
    if (!Object.keys(locales).length) addIssue('warning', 'missing-character-locales', tr('{character} is missing localized names', { character: parsed?.name || masterInfo?.zh || characterId }), { kind: 'locale', characterId });
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
      addIssue('info', 'orphan-locale-entry', tr('Localized name {id} has no character master entry or skill file', { id: localeCharacterId }), { kind: 'locale', characterId: localeCharacterId });
    }
  }

  const effectViews = new Map<string, CharacterEffectView>();
  for (const entry of effectDefinitions.values()) {
    effectViews.set(entry.id, {
      id: entry.id,
      displayName: effectNames.get(entry.id) || entry.description || entry.id,
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
        displayName: effectNames.get(pending.effectId) || pending.effectId,
        description: tr('Not defined in effects.py'),
        category: '__undefined__',
        defined: false,
        usages: [],
      };
      effectViews.set(pending.effectId, effect);
      unknownEffectIds.add(pending.effectId);
      addIssue('error', 'unknown-effect-id', tr('{character} / {skill} references unknown effect {effect}', {
        character: pending.usage.characterName,
        skill: pending.usage.skillName,
        effect: pending.effectId,
      }), pending.source);
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
    effectCategories,
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
    effectNamesFile?: string;
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
    effectNamesFile: resolve(configured.effectNamesFile, 'assets/lang/effect_names.json'),
  };
}
