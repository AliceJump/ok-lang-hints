import * as vscode from 'vscode';

export type SupportedUiLocale = 'zh-cn' | 'zh-tw' | 'en' | 'ja' | 'ko' | 'es';

export function uiLocale(language = vscode.env.language): SupportedUiLocale {
  const normalized = language.toLowerCase().replace('_', '-');
  if (normalized === 'zh-cn' || normalized.startsWith('zh-hans') || normalized === 'zh') return 'zh-cn';
  if (normalized === 'zh-tw' || normalized.startsWith('zh-hant')) return 'zh-tw';
  if (normalized.startsWith('ja')) return 'ja';
  if (normalized.startsWith('ko')) return 'ko';
  if (normalized.startsWith('es')) return 'es';
  return 'en';
}

export function projectLocale(language = vscode.env.language): string {
  const locale = uiLocale(language);
  const map: Record<SupportedUiLocale, string> = {
    'zh-cn': 'zh_CN',
    'zh-tw': 'zh_TW',
    en: 'en_US',
    ja: 'ja_JP',
    ko: 'ko_KR',
    es: 'es_ES',
  };
  return map[locale];
}

export function tr(message: string, args?: Record<string, string | number | boolean>): string {
  return args ? vscode.l10n.t(message, args) : vscode.l10n.t(message);
}

export interface WebviewStrings {
  [key: string]: string;
}

const ZH_CN: WebviewStrings = {
  refresh: '刷新',
  open: '打开',
  add: '添加',
  modify: '修改',
  delete: '删除',
  cancel: '取消',
  save: '保存',
  copy: '复制',
  close: '关闭',
  search: '搜索',
  loading: '正在加载…',
  none: '无',
  current: '当前',
  enabled: '开启',
  disabled: '关闭',
  error: '错误',
  warning: '警告',
  info: '信息',
  charactersTitle: '角色技能管理',
  charactersTab: '角色与技能',
  effectsTab: '效果索引',
  localesTab: '名称本地化',
  issuesTab: '数据诊断',
  searchCharacters: '搜索角色、技能、效果、描述…',
  allStars: '全部星级',
  allElements: '全部元素',
  allProfessions: '全部职业',
  allSkillTypes: '全部技能类型',
  enhancementOnly: '仅显示含强化组的角色',
  issueOnly: '仅显示存在诊断的角色',
  characterCount: '{shown} / {total} 个角色',
  skillsEnhancements: '技能 / 强化',
  noCharacters: '没有匹配的角色',
  selectCharacter: '从左侧选择一个角色',
  unknownStar: '星级未定',
  unknownElement: '元素未定',
  unknownProfession: '职业未定',
  unknownWeapon: '武器未定',
  skillsCount: '{count} 个技能',
  enhancementsCount: '{count} 个强化组',
  openCharacterJson: '打开角色 JSON',
  skillsAndEnhancements: '技能与强化效果',
  addSkill: '添加技能',
  modifySkill: '修改技能',
  addEnhancement: '添加强化组',
  modifyEnhancement: '修改强化组',
  syncedSkillLocked: '同步技能 · ID/名称/类别/元素/描述锁定',
  enhancedState: '强化态',
  baseEffects: '基础效果',
  triggerEffects: '触发依赖效果',
  triggerEffectMode: '触发模式',
  triggerEffectModeAllHint: '全部依赖效果都满足时触发',
  triggerEffectModeAnyHint: '任一依赖效果满足时触发',
  outputEffects: '强化产出效果',
  visiblePulse: '可见脉冲',
  multiplier: '倍率',
  stagger: '失衡',
  cooldown: '冷却',
  spiritCost: '技力',
  noSkills: '该角色尚无技能数据',
  searchEffects: '搜索效果 ID、描述、角色或技能…',
  allCategories: '全部分类',
  allEffects: '全部效果',
  usedOnly: '仅已引用',
  unusedOnly: '仅未引用',
  unknownOnly: '仅未知',
  addEffectCategory: '添加类别',
  addEffect: '添加效果',
  effectsCount: '{shown} / {total} 个效果',
  noEffects: '没有匹配的效果',
  undefinedEffect: '未定义效果',
  openDefinition: '打开定义',
  moreUsages: '另有 {count} 处引用',
  localizationMatrix: '角色名称多语言矩阵',
  localizationHint: '空白单元格表示缺失，可点击角色打开语言源文件。',
  characterIdColumn: '角色 / ID',
  missing: '缺失',
  searchIssues: '搜索诊断信息…',
  allSeverities: '全部级别',
  issuesCount: '{shown} / {total} 条诊断',
  noIssuesMatch: '没有匹配的诊断',
  noIssues: '未发现数据问题',
  openSource: '打开源文件',
  readingCharacterData: '正在读取角色、技能、效果与多语言数据…',
  skillId: '技能 ID',
  skillName: '技能名称',
  skillType: '技能类型',
  element: '元素',
  damageMultiplier: '伤害倍率',
  staggerValue: '失衡值',
  cooldownField: '冷却',
  spiritCostField: '技力消耗',
  skillDescription: '技能描述',
  baseEffectsMulti: '基础效果（可多选）',
  enhancementName: '强化组名称',
  visibleMarker: '显示标记',
  triggerText: '触发条件文本',
  enhancementDescription: '强化效果说明',
  triggerEffectsMulti: '触发依赖效果（可多选）',
  outputEffectsMulti: '强化产出效果（可多选）',
  effectCategory: '效果类别',
  effectId: '效果 ID（大写下划线）',
  effectDescription: '效果描述',
  categoryName: '类别名称',
  effectMultiHint: '按住 Ctrl / Cmd 可多选；选项来源于 effects.py，并按效果类别分组。',
  selectedTriggerEffects: '已选择 {count} 个触发依赖效果',
  noTriggerEffects: '未选择触发依赖效果',
  noSelectedEffects: '未选择效果',
  unknownEffect: '未知效果',
  unknownCurrentEffect: '当前数据中的未知效果',
  inferredFromTriggerText: '由触发文本推断',
  clickCopySkillId: '单击复制技能 ID',
  clickCopyEffectId: '单击复制效果 ID',
  openCharacterLocaleFile: '打开角色名称语言文件',
  loadFailed: '加载失败',
  saveFailed: '保存失败',
  charactersMetric: '角色',
  skillsMetric: '技能',
  enhancementsMetric: '强化组',
  effectReferencesMetric: '效果引用',
  effectDefinitionsMetric: '效果定义',
  valueLabel: '值',
  confirmDelete: '确定删除“{name}”吗？\n保存前会自动创建 .bak 备份。',
  copied: '已复制：{text}',
  taskTitle: 'ok-script 任务启动',
  noTasks: '未找到任务。\n请先在设置中配置项目路径。',
  parameters: '参数',
  collapseParameters: '收起参数',
  launch: '启动',
  stop: '停止',
  running: '运行中…',
  oneTimeTask: '一次性',
  triggerTask: '触发任务',
  configGroup: '配置分组',
  commonParameters: '通用参数',
  groupParameters: '分组参数',
  childTaskConfig: '子任务配置',
  otherParameters: '其他参数',
  launchSettings: '启动设置',
  extraArgs: '额外参数',
  extraArgsHint: '支持引号语法，或填写 JSON 字符串数组。',
  environmentVariables: '环境变量',
  environmentHint: '每行 KEY=VALUE；仅传给当前任务子进程。',
  timeoutSeconds: '自动停止超时（秒）',
  timeoutHint: '0 表示不限时。',
  saveParameters: '保存参数',
  reset: '重置',
  saveLaunchSettings: '保存启动设置',
  noConfigParameters: '暂无可配置参数（schema 未就绪或该任务无 default_config）。',
  schemaFailed: '该任务 schema 采集失败，无法自动生成表单：{error}',
  holdCtrlMulti: '按住 Ctrl 多选',
  currentValue: '{value}（当前）',
  selectedOptionsHint: '可选值：{values}',
  structuredJsonHint: 'JSON 数组；支持条件对象与动作序列。',
  stopping: '正在停止任务…',
  timeoutStopping: '任务已超时，正在停止…',
  taskStopped: '任务已停止，详见输出面板',
  taskTimedOut: '任务超时并已停止，详见输出面板',
  taskCompleted: '任务完成，详见输出面板',
  taskFailed: '任务异常结束，详见输出面板',
  toolboxOpenCharacterManager: '打开角色技能管理面板',
  templatesSearch: '搜索模板名…',
  templatesTitle: '模板面板',
  templatesHint: '单击=插入到代码 · 双击=复制 · 悬停缩略图点👁=查看原图',
  templatesCount: '{shown}/{total} 个模板',
  noTemplates: '未找到任何模板。',
  noTemplatesWithHint: '未找到任何模板。\n请确认工作区存在 assets/coco_annotations.json\n（或 ok_tasks/assets/coco_annotations.json）。',
  noTemplateMatch: '没有匹配“{query}”的模板。',
  viewOriginal: '查看原图（红框标注位置）',
  thumbnailStats: '缩略图 {loaded} 成功',
  thumbnailStatsWithFailures: '缩略图 {loaded} 成功 / {failed} 失败',
  thumbnailLoadFailed: '缩略图加载失败',
  templateSize: '尺寸: {width}×{height}',
  templateSource: '来源: {path}',
  templateAssetsTitle: '模板素材管理',
  templateAssetsHint: '单击/双击=打开标注编辑器',
  noTemplateAssets: '暂无模板素材。\n点击 Import 导入图片，或截屏后粘贴。',
  noTemplateAssetsHint: '暂无模板素材。',
  screenshotSaved: '截图已保存: {name}',
  screenshotFailed: '截图保存失败: {error}',
  noClipboardImage: '剪贴板中没有图片。请先截图（PrintScreen），然后在此粘贴。',
  saveToAssetsTitle: '保存到项目 assets',
  saveToAssetsSuccess: '已保存到: {path}',
  saveToAssetsFailed: '保存失败: {error}',
  deleteImageConfirm: '确定删除"{name}"吗？此操作不可撤销。',
  deleteImageSuccess: '已删除: {name}',
  deleteImageFailed: '删除失败: {name}',
  importImagesTitle: '导入图片到 ok_templates',
  importImagesSuccess: '已导入 {count} 张图片',
  annotationEditor: '标注编辑器',
  drawBbox: '画框 (R)',
  deleteMode: '删除模式 (D)',
  modifyBbox: '修改',
  newBboxTitle: '新建标注框',
  editBboxTitle: '编辑标注框',
  categoryRequired: '请输入分类名称',
  categoryExists: '已存在于"{file}"中',
  categoryLabel: '分类:',
  widthLabel: '宽度:',
  heightLabel: '高度:',
};

const EN: WebviewStrings = {
  ...ZH_CN,
  refresh: 'Refresh', open: 'Open', add: 'Add', modify: 'Modify', delete: 'Delete', cancel: 'Cancel', save: 'Save', copy: 'Copy', close: 'Close', search: 'Search', loading: 'Loading…', none: 'None', current: 'Current', enabled: 'On', disabled: 'Off', error: 'Error', warning: 'Warning', info: 'Info',
  charactersTitle: 'Character & Skill Manager', charactersTab: 'Characters & Skills', effectsTab: 'Effect Index', localesTab: 'Name Localization', issuesTab: 'Diagnostics', searchCharacters: 'Search characters, skills, effects, descriptions…', allStars: 'All Rarities', allElements: 'All Elements', allProfessions: 'All Professions', allSkillTypes: 'All Skill Types', enhancementOnly: 'Only characters with enhancements', issueOnly: 'Only characters with diagnostics', characterCount: '{shown} / {total} characters', skillsEnhancements: 'Skills / Enhancements', noCharacters: 'No matching characters', selectCharacter: 'Select a character from the left', unknownStar: 'Rarity unknown', unknownElement: 'Element unknown', unknownProfession: 'Profession unknown', unknownWeapon: 'Weapon unknown', skillsCount: '{count} skills', enhancementsCount: '{count} enhancements', openCharacterJson: 'Open Character JSON', skillsAndEnhancements: 'Skills & Enhancements', addSkill: 'Add Skill', modifySkill: 'Modify Skill', addEnhancement: 'Add Enhancement', modifyEnhancement: 'Modify Enhancement', syncedSkillLocked: 'Synced skill · ID/name/type/element/description locked', enhancedState: 'Enhanced', baseEffects: 'Base Effects', triggerEffects: 'Trigger Dependencies', outputEffects: 'Enhancement Effects', visiblePulse: 'Visible Pulse', multiplier: 'Multiplier', stagger: 'Stagger', cooldown: 'Cooldown', spiritCost: 'SP Cost', noSkills: 'No skill data for this character',
  searchEffects: 'Search effect ID, description, character, or skill…', allCategories: 'All Categories', allEffects: 'All Effects', usedOnly: 'Used Only', unusedOnly: 'Unused Only', unknownOnly: 'Unknown Only', addEffectCategory: 'Add Category', addEffect: 'Add Effect', effectsCount: '{shown} / {total} effects', noEffects: 'No matching effects', undefinedEffect: 'Undefined Effect', openDefinition: 'Open Definition', moreUsages: '{count} more usages', localizationMatrix: 'Character Name Localization Matrix', localizationHint: 'Blank cells are missing. Click a character to open the language source.', characterIdColumn: 'Character / ID', missing: 'Missing', searchIssues: 'Search diagnostics…', allSeverities: 'All Severities', issuesCount: '{shown} / {total} diagnostics', noIssuesMatch: 'No matching diagnostics', noIssues: 'No data issues found', openSource: 'Open Source', readingCharacterData: 'Reading characters, skills, effects, and localization data…',
  skillId: 'Skill ID', skillName: 'Skill Name', skillType: 'Skill Type', element: 'Element', damageMultiplier: 'Damage Multiplier', staggerValue: 'Stagger', cooldownField: 'Cooldown', spiritCostField: 'SP Cost', skillDescription: 'Skill Description', baseEffectsMulti: 'Base Effects (multi-select)', enhancementName: 'Enhancement Name', visibleMarker: 'Display Marker', triggerText: 'Trigger Condition', enhancementDescription: 'Enhancement Description', triggerEffectsMulti: 'Trigger Dependencies (multi-select)', outputEffectsMulti: 'Enhancement Effects (multi-select)', effectCategory: 'Effect Category', effectId: 'Effect ID (UPPER_SNAKE_CASE)', effectDescription: 'Effect Description', categoryName: 'Category Name', effectMultiHint: 'Hold Ctrl / Cmd to multi-select. Options come from effects.py and are grouped by category.', selectedTriggerEffects: '{count} trigger dependencies selected', noTriggerEffects: 'No trigger dependencies selected', noSelectedEffects: 'No effects selected', unknownEffect: 'Unknown effect', unknownCurrentEffect: 'Unknown effect in current data', inferredFromTriggerText: 'Inferred from trigger text', clickCopySkillId: 'Click to copy skill ID', clickCopyEffectId: 'Click to copy effect ID', openCharacterLocaleFile: 'Open character name language file', loadFailed: 'Failed to load', saveFailed: 'Failed to save', charactersMetric: 'Characters', skillsMetric: 'Skills', enhancementsMetric: 'Enhancements', effectReferencesMetric: 'Effect References', effectDefinitionsMetric: 'Effect Definitions', valueLabel: 'Value', confirmDelete: 'Delete “{name}”?\nA .bak backup is created before saving.', copied: 'Copied: {text}',
  taskTitle: 'ok-script Task Launcher', noTasks: 'No tasks found.\nConfigure the project path first.', parameters: 'Parameters', collapseParameters: 'Collapse Parameters', launch: 'Launch', stop: 'Stop', running: 'Running…', oneTimeTask: 'One-time', triggerTask: 'Trigger', configGroup: 'Configuration Group', commonParameters: 'Common Parameters', groupParameters: 'Group Parameters', childTaskConfig: 'Child Task Configuration', otherParameters: 'Other Parameters', launchSettings: 'Launch Settings', extraArgs: 'Extra Arguments', extraArgsHint: 'Supports quoted arguments or a JSON string array.', environmentVariables: 'Environment Variables', environmentHint: 'One KEY=VALUE per line; only passed to this task process.', timeoutSeconds: 'Auto-stop Timeout (seconds)', timeoutHint: '0 means no timeout.', saveParameters: 'Save Parameters', reset: 'Reset', saveLaunchSettings: 'Save Launch Settings', noConfigParameters: 'No configurable parameters (schema not ready or task has no default_config).', schemaFailed: 'Schema collection failed: {error}', holdCtrlMulti: 'Hold Ctrl to select multiple items', currentValue: '{value} (current)', selectedOptionsHint: 'Available values: {values}', structuredJsonHint: 'JSON array supporting condition objects and action sequences.', stopping: 'Stopping task…', timeoutStopping: 'Task timed out; stopping…', taskStopped: 'Task stopped. See Output for details.', taskTimedOut: 'Task timed out and was stopped. See Output for details.', taskCompleted: 'Task completed. See Output for details.', taskFailed: 'Task ended with an error. See Output for details.', toolboxOpenCharacterManager: 'Open Character & Skill Manager', templatesSearch: 'Search template names…', templatesTitle: 'Template Gallery', templatesHint: 'Click=insert · Double-click=copy · Hover thumbnail and click 👁 to view source', templatesCount: '{shown}/{total} templates', noTemplates: 'No templates found.', noTemplatesWithHint: 'No templates found.\nMake sure the workspace contains assets/coco_annotations.json\n(or ok_tasks/assets/coco_annotations.json).', noTemplateMatch: 'No templates match “{query}”.', viewOriginal: 'View source image with highlighted bounds', thumbnailStats: '{loaded} thumbnails loaded', thumbnailStatsWithFailures: '{loaded} thumbnails loaded / {failed} failed', thumbnailLoadFailed: 'Thumbnail failed to load', templateSize: 'Size: {width}×{height}', templateSource: 'Source: {path}',
};

const ZH_TW: WebviewStrings = {
  ...ZH_CN,
  refresh: '重新整理', open: '開啟', add: '新增', modify: '修改', delete: '刪除', cancel: '取消', save: '儲存', copy: '複製', close: '關閉', search: '搜尋', loading: '載入中…', none: '無', current: '目前', enabled: '開啟', disabled: '關閉', error: '錯誤', warning: '警告', info: '資訊',
  charactersTitle: '角色技能管理', charactersTab: '角色與技能', effectsTab: '效果索引', localesTab: '名稱本地化', issuesTab: '資料診斷', searchCharacters: '搜尋角色、技能、效果、描述…', allStars: '全部星級', allElements: '全部元素', allProfessions: '全部職業', allSkillTypes: '全部技能類型', enhancementOnly: '僅顯示含強化組的角色', issueOnly: '僅顯示存在診斷的角色', characterCount: '{shown} / {total} 個角色', skillsEnhancements: '技能 / 強化', noCharacters: '沒有符合的角色', selectCharacter: '從左側選擇角色', openCharacterJson: '開啟角色 JSON', skillsAndEnhancements: '技能與強化效果', addSkill: '新增技能', modifySkill: '修改技能', addEnhancement: '新增強化組', modifyEnhancement: '修改強化組', baseEffects: '基礎效果', triggerEffects: '觸發依賴效果', outputEffects: '強化產出效果', visiblePulse: '可見脈衝', searchEffects: '搜尋效果 ID、描述、角色或技能…', allCategories: '全部分類', allEffects: '全部效果', usedOnly: '僅已引用', unusedOnly: '僅未引用', unknownOnly: '僅未知', addEffectCategory: '新增分類', addEffect: '新增效果', localizationMatrix: '角色名稱多語言矩陣', localizationHint: '空白儲存格表示缺失，可點擊角色開啟語言來源檔案。', missing: '缺失', searchIssues: '搜尋診斷資訊…', allSeverities: '全部級別', openSource: '開啟來源檔案', readingCharacterData: '正在讀取角色、技能、效果與多語言資料…', unknownCurrentEffect: '目前資料中的未知效果', inferredFromTriggerText: '由觸發文字推斷', clickCopySkillId: '點擊複製技能 ID', clickCopyEffectId: '點擊複製效果 ID', openCharacterLocaleFile: '開啟角色名稱語言檔案', loadFailed: '載入失敗', saveFailed: '儲存失敗', charactersMetric: '角色', skillsMetric: '技能', enhancementsMetric: '強化組', effectReferencesMetric: '效果引用', effectDefinitionsMetric: '效果定義', valueLabel: '值', taskTitle: 'ok-script 任務啟動', noTasks: '找不到任務。\n請先在設定中配置專案路徑。', parameters: '參數', launch: '啟動', stop: '停止', running: '執行中…', toolboxOpenCharacterManager: '開啟角色技能管理面板', templatesSearch: '搜尋模板名稱…', templatesTitle: '模板面板', noTemplates: '找不到任何模板。', noTemplatesWithHint: '找不到任何模板。\n請確認工作區存在 assets/coco_annotations.json\n（或 ok_tasks/assets/coco_annotations.json）。', thumbnailStats: '已載入 {loaded} 個縮圖', thumbnailStatsWithFailures: '已載入 {loaded} 個縮圖 / {failed} 個失敗', thumbnailLoadFailed: '縮圖載入失敗', templateSize: '尺寸：{width}×{height}', templateSource: '來源：{path}',
  unknownStar: '星級未定', unknownElement: '元素未定', unknownProfession: '職業未定', unknownWeapon: '武器未定', skillsCount: '{count} 個技能', enhancementsCount: '{count} 個強化組', syncedSkillLocked: '同步技能 · ID/名稱/類型/元素/描述已鎖定', enhancedState: '強化態', multiplier: '倍率', stagger: '失衡', cooldown: '冷卻', spiritCost: '技力', noSkills: '此角色尚無技能資料', effectsCount: '{shown} / {total} 個效果', noEffects: '沒有符合的效果', undefinedEffect: '未定義效果', openDefinition: '開啟定義', moreUsages: '另有 {count} 處引用', characterIdColumn: '角色 / ID', issuesCount: '{shown} / {total} 條診斷', noIssuesMatch: '沒有符合的診斷', noIssues: '未發現資料問題', skillId: '技能 ID', skillName: '技能名稱', skillType: '技能類型', element: '元素', damageMultiplier: '傷害倍率', staggerValue: '失衡值', cooldownField: '冷卻', spiritCostField: '技力消耗', skillDescription: '技能描述', baseEffectsMulti: '基礎效果（可多選）', enhancementName: '強化組名稱', visibleMarker: '顯示標記', triggerText: '觸發條件文字', enhancementDescription: '強化效果說明', triggerEffectsMulti: '觸發依賴效果（可多選）', outputEffectsMulti: '強化產出效果（可多選）', effectCategory: '效果分類', effectId: '效果 ID（大寫底線）', effectDescription: '效果描述', categoryName: '分類名稱', effectMultiHint: '按住 Ctrl / Cmd 可多選；選項來自 effects.py，並依效果分類分組。', selectedTriggerEffects: '已選擇 {count} 個觸發依賴效果', noTriggerEffects: '未選擇觸發依賴效果', noSelectedEffects: '未選擇效果', unknownEffect: '未知效果', confirmDelete: '確定要刪除「{name}」嗎？\n儲存前會自動建立 .bak 備份。', copied: '已複製：{text}', collapseParameters: '收合參數', oneTimeTask: '一次性', triggerTask: '觸發任務', configGroup: '設定分組', commonParameters: '通用參數', groupParameters: '分組參數', childTaskConfig: '子任務設定', otherParameters: '其他參數', launchSettings: '啟動設定', extraArgs: '額外參數', extraArgsHint: '支援引號語法，或填寫 JSON 字串陣列。', environmentVariables: '環境變數', environmentHint: '每行 KEY=VALUE；僅傳給目前任務子程序。', timeoutSeconds: '自動停止逾時（秒）', timeoutHint: '0 表示不限時。', saveParameters: '儲存參數', reset: '重設', saveLaunchSettings: '儲存啟動設定', noConfigParameters: '目前沒有可設定參數（schema 尚未就緒或任務沒有 default_config）。', schemaFailed: '此任務 schema 收集失敗，無法自動產生表單：{error}', holdCtrlMulti: '按住 Ctrl 多選', currentValue: '{value}（目前）', selectedOptionsHint: '可選值：{values}', structuredJsonHint: 'JSON 陣列；支援條件物件與動作序列。', stopping: '正在停止任務…', timeoutStopping: '任務已逾時，正在停止…', taskStopped: '任務已停止，詳見輸出面板', taskTimedOut: '任務逾時並已停止，詳見輸出面板', taskCompleted: '任務完成，詳見輸出面板', taskFailed: '任務異常結束，詳見輸出面板', templatesHint: '單擊=插入 · 雙擊=複製 · 將游標移到縮圖並點擊 👁 檢視原圖', templatesCount: '{shown}/{total} 個模板', noTemplateMatch: '沒有符合「{query}」的模板。', viewOriginal: '檢視原圖（標示位置）',
};

const JA: WebviewStrings = {
  ...EN,
  refresh: '更新', open: '開く', add: '追加', modify: '変更', delete: '削除', cancel: 'キャンセル', save: '保存', copy: 'コピー', close: '閉じる', search: '検索', loading: '読み込み中…', none: 'なし', current: '現在', enabled: 'オン', disabled: 'オフ', error: 'エラー', warning: '警告', info: '情報', charactersTitle: 'キャラクター・スキル管理', charactersTab: 'キャラクターとスキル', effectsTab: '効果インデックス', localesTab: '名前のローカライズ', issuesTab: 'データ診断', searchCharacters: 'キャラクター、スキル、効果、説明を検索…', addSkill: 'スキルを追加', modifySkill: 'スキルを変更', addEnhancement: '強化グループを追加', modifyEnhancement: '強化グループを変更', addEffectCategory: 'カテゴリを追加', addEffect: '効果を追加', charactersMetric: 'キャラクター', skillsMetric: 'スキル', enhancementsMetric: '強化', effectReferencesMetric: '効果参照', effectDefinitionsMetric: '効果定義', valueLabel: '値', loadFailed: '読み込みに失敗しました', saveFailed: '保存に失敗しました', taskTitle: 'ok-script タスク起動', launch: '起動', stop: '停止', parameters: 'パラメータ', toolboxOpenCharacterManager: 'キャラクター・スキル管理を開く', templatesTitle: 'テンプレートギャラリー', templatesSearch: 'テンプレート名を検索…', noTemplatesWithHint: 'テンプレートが見つかりません。\nワークスペースに assets/coco_annotations.json\n（または ok_tasks/assets/coco_annotations.json）があることを確認してください。',
  allStars: 'すべてのレア度', allElements: 'すべての元素', allProfessions: 'すべての職業', allSkillTypes: 'すべてのスキルタイプ', enhancementOnly: '強化グループのあるキャラクターのみ', issueOnly: '診断のあるキャラクターのみ', characterCount: '{shown} / {total} キャラクター', skillsEnhancements: 'スキル / 強化', noCharacters: '一致するキャラクターがありません', selectCharacter: '左側からキャラクターを選択してください', unknownStar: 'レア度未設定', unknownElement: '元素未設定', unknownProfession: '職業未設定', unknownWeapon: '武器未設定', skillsCount: '{count} スキル', enhancementsCount: '{count} 強化グループ', openCharacterJson: 'キャラクター JSON を開く', skillsAndEnhancements: 'スキルと強化効果', syncedSkillLocked: '同期スキル · ID/名前/タイプ/元素/説明はロック済み', enhancedState: '強化状態', baseEffects: '基本効果', triggerEffects: 'トリガー依存効果', outputEffects: '強化出力効果', visiblePulse: '可視パルス', multiplier: '倍率', stagger: 'ブレイク', cooldown: 'クールダウン', spiritCost: 'SP 消費', noSkills: 'このキャラクターにはスキルデータがありません', searchEffects: '効果 ID、説明、キャラクター、スキルを検索…', allCategories: 'すべてのカテゴリ', allEffects: 'すべての効果', usedOnly: '使用中のみ', unusedOnly: '未使用のみ', unknownOnly: '不明のみ', effectsCount: '{shown} / {total} 効果', noEffects: '一致する効果がありません', undefinedEffect: '未定義の効果', openDefinition: '定義を開く', moreUsages: 'ほか {count} 箇所で参照', localizationMatrix: 'キャラクター名ローカライズ表', localizationHint: '空欄は欠落を示します。キャラクターをクリックすると言語ソースを開けます。', characterIdColumn: 'キャラクター / ID', missing: '欠落', searchIssues: '診断を検索…', allSeverities: 'すべての重要度', issuesCount: '{shown} / {total} 件の診断', noIssuesMatch: '一致する診断がありません', noIssues: 'データ問題は見つかりませんでした', openSource: 'ソースを開く', readingCharacterData: 'キャラクター、スキル、効果、ローカライズデータを読み込み中…', skillId: 'スキル ID', skillName: 'スキル名', skillType: 'スキルタイプ', element: '元素', damageMultiplier: 'ダメージ倍率', staggerValue: 'ブレイク値', cooldownField: 'クールダウン', spiritCostField: 'SP 消費', skillDescription: 'スキル説明', baseEffectsMulti: '基本効果（複数選択）', enhancementName: '強化グループ名', visibleMarker: '表示マーカー', triggerText: 'トリガー条件テキスト', enhancementDescription: '強化効果の説明', triggerEffectsMulti: 'トリガー依存効果（複数選択）', outputEffectsMulti: '強化出力効果（複数選択）', effectCategory: '効果カテゴリ', effectId: '効果 ID（大文字スネークケース）', effectDescription: '効果説明', categoryName: 'カテゴリ名', effectMultiHint: 'Ctrl / Cmd を押しながら複数選択できます。選択肢は effects.py から取得し、カテゴリ別に表示します。', selectedTriggerEffects: 'トリガー依存効果を {count} 件選択', noTriggerEffects: 'トリガー依存効果が選択されていません', noSelectedEffects: '効果が選択されていません', unknownEffect: '不明な効果', unknownCurrentEffect: '現在のデータ内の不明な効果', inferredFromTriggerText: 'トリガーテキストから推定', clickCopySkillId: 'クリックしてスキル ID をコピー', clickCopyEffectId: 'クリックして効果 ID をコピー', openCharacterLocaleFile: 'キャラクター名の言語ファイルを開く', confirmDelete: '「{name}」を削除しますか？\n保存前に .bak バックアップを自動作成します。', copied: 'コピーしました: {text}', noTasks: 'タスクが見つかりません。\n先にプロジェクトパスを設定してください。', collapseParameters: 'パラメーターを折りたたむ', running: '実行中…', oneTimeTask: '単発', triggerTask: 'トリガー', configGroup: '設定グループ', commonParameters: '共通パラメーター', groupParameters: 'グループパラメーター', childTaskConfig: '子タスク設定', otherParameters: 'その他のパラメーター', launchSettings: '起動設定', extraArgs: '追加引数', extraArgsHint: '引用符付き引数または JSON 文字列配列を使用できます。', environmentVariables: '環境変数', environmentHint: '1 行に KEY=VALUE。現在のタスクプロセスだけに渡します。', timeoutSeconds: '自動停止タイムアウト（秒）', timeoutHint: '0 は制限なしです。', saveParameters: 'パラメーターを保存', reset: 'リセット', saveLaunchSettings: '起動設定を保存', noConfigParameters: '設定可能なパラメーターがありません（schema 未準備、または default_config なし）。', schemaFailed: 'このタスクの schema 収集に失敗しました: {error}', holdCtrlMulti: 'Ctrl を押しながら複数選択', currentValue: '{value}（現在）', selectedOptionsHint: '選択可能な値: {values}', structuredJsonHint: '条件オブジェクトとアクション列を含む JSON 配列。', stopping: 'タスクを停止しています…', timeoutStopping: 'タスクがタイムアウトしました。停止しています…', taskStopped: 'タスクを停止しました。詳細は出力を確認してください。', taskTimedOut: 'タスクがタイムアウトして停止しました。詳細は出力を確認してください。', taskCompleted: 'タスクが完了しました。詳細は出力を確認してください。', taskFailed: 'タスクがエラーで終了しました。詳細は出力を確認してください。', templatesHint: 'クリック=挿入 · ダブルクリック=コピー · サムネイルにカーソルを合わせて 👁 をクリックすると元画像を表示', templatesCount: '{shown}/{total} テンプレート', noTemplates: 'テンプレートが見つかりません。', noTemplateMatch: '「{query}」に一致するテンプレートがありません。', viewOriginal: '位置を強調表示した元画像を表示', thumbnailStats: 'サムネイル {loaded} 件を読み込み', thumbnailStatsWithFailures: 'サムネイル {loaded} 件を読み込み / {failed} 件失敗', thumbnailLoadFailed: 'サムネイルの読み込みに失敗', templateSize: 'サイズ: {width}×{height}', templateSource: 'ソース: {path}',
};

const KO: WebviewStrings = {
  ...EN,
  refresh: '새로 고침', open: '열기', add: '추가', modify: '수정', delete: '삭제', cancel: '취소', save: '저장', copy: '복사', close: '닫기', search: '검색', loading: '불러오는 중…', none: '없음', current: '현재', enabled: '켜짐', disabled: '꺼짐', error: '오류', warning: '경고', info: '정보', charactersTitle: '캐릭터·스킬 관리', charactersTab: '캐릭터와 스킬', effectsTab: '효과 인덱스', localesTab: '이름 현지화', issuesTab: '데이터 진단', searchCharacters: '캐릭터, 스킬, 효과, 설명 검색…', addSkill: '스킬 추가', modifySkill: '스킬 수정', addEnhancement: '강화 그룹 추가', modifyEnhancement: '강화 그룹 수정', addEffectCategory: '분류 추가', addEffect: '효과 추가', charactersMetric: '캐릭터', skillsMetric: '스킬', enhancementsMetric: '강화 그룹', effectReferencesMetric: '효과 참조', effectDefinitionsMetric: '효과 정의', valueLabel: '값', loadFailed: '불러오기 실패', saveFailed: '저장 실패', taskTitle: 'ok-script 작업 실행', launch: '실행', stop: '중지', parameters: '매개변수', toolboxOpenCharacterManager: '캐릭터·스킬 관리 열기', templatesTitle: '템플릿 갤러리', templatesSearch: '템플릿 이름 검색…', noTemplatesWithHint: '템플릿을 찾을 수 없습니다.\n작업 영역에 assets/coco_annotations.json\n(또는 ok_tasks/assets/coco_annotations.json)이 있는지 확인하세요.',
  allStars: '모든 희귀도', allElements: '모든 원소', allProfessions: '모든 직업', allSkillTypes: '모든 스킬 유형', enhancementOnly: '강화 그룹이 있는 캐릭터만', issueOnly: '진단이 있는 캐릭터만', characterCount: '{shown} / {total} 캐릭터', skillsEnhancements: '스킬 / 강화', noCharacters: '일치하는 캐릭터가 없습니다', selectCharacter: '왼쪽에서 캐릭터를 선택하세요', unknownStar: '희귀도 미정', unknownElement: '원소 미정', unknownProfession: '직업 미정', unknownWeapon: '무기 미정', skillsCount: '스킬 {count}개', enhancementsCount: '강화 그룹 {count}개', openCharacterJson: '캐릭터 JSON 열기', skillsAndEnhancements: '스킬 및 강화 효과', syncedSkillLocked: '동기화 스킬 · ID/이름/유형/원소/설명 잠김', enhancedState: '강화 상태', baseEffects: '기본 효과', triggerEffects: '트리거 의존 효과', outputEffects: '강화 출력 효과', visiblePulse: '표시 펄스', multiplier: '배율', stagger: '브레이크', cooldown: '재사용 대기시간', spiritCost: 'SP 소모', noSkills: '이 캐릭터에는 스킬 데이터가 없습니다', searchEffects: '효과 ID, 설명, 캐릭터 또는 스킬 검색…', allCategories: '모든 분류', allEffects: '모든 효과', usedOnly: '사용 중만', unusedOnly: '미사용만', unknownOnly: '알 수 없음만', effectsCount: '{shown} / {total} 효과', noEffects: '일치하는 효과가 없습니다', undefinedEffect: '정의되지 않은 효과', openDefinition: '정의 열기', moreUsages: '참조 {count}개 더 있음', localizationMatrix: '캐릭터 이름 현지화 매트릭스', localizationHint: '빈 셀은 누락을 의미합니다. 캐릭터를 클릭해 언어 원본을 여세요.', characterIdColumn: '캐릭터 / ID', missing: '누락', searchIssues: '진단 검색…', allSeverities: '모든 심각도', issuesCount: '{shown} / {total} 진단', noIssuesMatch: '일치하는 진단이 없습니다', noIssues: '데이터 문제가 없습니다', openSource: '소스 열기', readingCharacterData: '캐릭터, 스킬, 효과 및 현지화 데이터 읽는 중…', skillId: '스킬 ID', skillName: '스킬 이름', skillType: '스킬 유형', element: '원소', damageMultiplier: '피해 배율', staggerValue: '브레이크 값', cooldownField: '재사용 대기시간', spiritCostField: 'SP 소모', skillDescription: '스킬 설명', baseEffectsMulti: '기본 효과(다중 선택)', enhancementName: '강화 그룹 이름', visibleMarker: '표시 마커', triggerText: '트리거 조건 텍스트', enhancementDescription: '강화 효과 설명', triggerEffectsMulti: '트리거 의존 효과(다중 선택)', outputEffectsMulti: '강화 출력 효과(다중 선택)', effectCategory: '효과 분류', effectId: '효과 ID(대문자 스네이크 표기)', effectDescription: '효과 설명', categoryName: '분류 이름', effectMultiHint: 'Ctrl / Cmd를 누른 채 다중 선택할 수 있습니다. 선택지는 effects.py에서 가져와 분류별로 표시합니다.', selectedTriggerEffects: '트리거 의존 효과 {count}개 선택됨', noTriggerEffects: '트리거 의존 효과를 선택하지 않았습니다', noSelectedEffects: '효과를 선택하지 않았습니다', unknownEffect: '알 수 없는 효과', unknownCurrentEffect: '현재 데이터의 알 수 없는 효과', inferredFromTriggerText: '트리거 텍스트에서 추론', clickCopySkillId: '클릭하여 스킬 ID 복사', clickCopyEffectId: '클릭하여 효과 ID 복사', openCharacterLocaleFile: '캐릭터 이름 언어 파일 열기', confirmDelete: '“{name}”을(를) 삭제하시겠습니까?\n저장 전에 .bak 백업을 자동 생성합니다.', copied: '복사됨: {text}', noTasks: '작업을 찾을 수 없습니다.\n먼저 프로젝트 경로를 설정하세요.', collapseParameters: '매개변수 접기', running: '실행 중…', oneTimeTask: '일회성', triggerTask: '트리거', configGroup: '설정 그룹', commonParameters: '공통 매개변수', groupParameters: '그룹 매개변수', childTaskConfig: '하위 작업 설정', otherParameters: '기타 매개변수', launchSettings: '실행 설정', extraArgs: '추가 인수', extraArgsHint: '따옴표 인수 또는 JSON 문자열 배열을 지원합니다.', environmentVariables: '환경 변수', environmentHint: '한 줄에 KEY=VALUE. 현재 작업 프로세스에만 전달합니다.', timeoutSeconds: '자동 중지 시간 제한(초)', timeoutHint: '0은 제한 없음입니다.', saveParameters: '매개변수 저장', reset: '초기화', saveLaunchSettings: '실행 설정 저장', noConfigParameters: '설정 가능한 매개변수가 없습니다(schema 미준비 또는 default_config 없음).', schemaFailed: '이 작업의 schema 수집 실패: {error}', holdCtrlMulti: 'Ctrl을 누른 채 다중 선택', currentValue: '{value}(현재)', selectedOptionsHint: '선택 가능 값: {values}', structuredJsonHint: '조건 객체와 작업 시퀀스를 지원하는 JSON 배열입니다.', stopping: '작업을 중지하는 중…', timeoutStopping: '작업 시간이 초과되어 중지하는 중…', taskStopped: '작업이 중지되었습니다. 자세한 내용은 출력을 확인하세요.', taskTimedOut: '작업 시간이 초과되어 중지되었습니다. 자세한 내용은 출력을 확인하세요.', taskCompleted: '작업이 완료되었습니다. 자세한 내용은 출력을 확인하세요.', taskFailed: '작업이 오류로 종료되었습니다. 자세한 내용은 출력을 확인하세요.', templatesHint: '클릭=삽입 · 두 번 클릭=복사 · 미리 보기 위에서 👁을 클릭해 원본 보기', templatesCount: '{shown}/{total} 템플릿', noTemplates: '템플릿을 찾을 수 없습니다.', noTemplateMatch: '“{query}”와 일치하는 템플릿이 없습니다.', viewOriginal: '위치를 강조 표시한 원본 이미지 보기', thumbnailStats: '미리 보기 {loaded}개 불러옴', thumbnailStatsWithFailures: '미리 보기 {loaded}개 불러옴 / {failed}개 실패', thumbnailLoadFailed: '미리 보기 불러오기 실패', templateSize: '크기: {width}×{height}', templateSource: '소스: {path}',
};

const ES: WebviewStrings = {
  ...EN,
  refresh: 'Actualizar', open: 'Abrir', add: 'Añadir', modify: 'Modificar', delete: 'Eliminar', cancel: 'Cancelar', save: 'Guardar', copy: 'Copiar', close: 'Cerrar', search: 'Buscar', loading: 'Cargando…', none: 'Ninguno', current: 'Actual', enabled: 'Activado', disabled: 'Desactivado', error: 'Error', warning: 'Advertencia', info: 'Información', charactersTitle: 'Gestor de personajes y habilidades', charactersTab: 'Personajes y habilidades', effectsTab: 'Índice de efectos', localesTab: 'Localización de nombres', issuesTab: 'Diagnóstico de datos', searchCharacters: 'Buscar personajes, habilidades, efectos o descripciones…', addSkill: 'Añadir habilidad', modifySkill: 'Modificar habilidad', addEnhancement: 'Añadir mejora', modifyEnhancement: 'Modificar mejora', addEffectCategory: 'Añadir categoría', addEffect: 'Añadir efecto', charactersMetric: 'Personajes', skillsMetric: 'Habilidades', enhancementsMetric: 'Mejoras', effectReferencesMetric: 'Referencias de efectos', effectDefinitionsMetric: 'Definiciones de efectos', valueLabel: 'Valor', loadFailed: 'Error al cargar', saveFailed: 'Error al guardar', taskTitle: 'Lanzador de tareas de ok-script', launch: 'Iniciar', stop: 'Detener', parameters: 'Parámetros', toolboxOpenCharacterManager: 'Abrir gestor de personajes y habilidades', templatesTitle: 'Galería de plantillas', templatesSearch: 'Buscar nombres de plantillas…', noTemplatesWithHint: 'No se encontraron plantillas.\nCompruebe que el espacio de trabajo contiene assets/coco_annotations.json\n(o ok_tasks/assets/coco_annotations.json).',
  allStars: 'Todas las rarezas', allElements: 'Todos los elementos', allProfessions: 'Todas las profesiones', allSkillTypes: 'Todos los tipos de habilidad', enhancementOnly: 'Solo personajes con mejoras', issueOnly: 'Solo personajes con diagnósticos', characterCount: '{shown} / {total} personajes', skillsEnhancements: 'Habilidades / Mejoras', noCharacters: 'No hay personajes coincidentes', selectCharacter: 'Seleccione un personaje de la izquierda', unknownStar: 'Rareza sin definir', unknownElement: 'Elemento sin definir', unknownProfession: 'Profesión sin definir', unknownWeapon: 'Arma sin definir', skillsCount: '{count} habilidades', enhancementsCount: '{count} mejoras', openCharacterJson: 'Abrir JSON del personaje', skillsAndEnhancements: 'Habilidades y mejoras', syncedSkillLocked: 'Habilidad sincronizada · ID/nombre/tipo/elemento/descripción bloqueados', enhancedState: 'Mejorada', baseEffects: 'Efectos base', triggerEffects: 'Dependencias del disparador', outputEffects: 'Efectos de la mejora', visiblePulse: 'Pulso visible', multiplier: 'Multiplicador', stagger: 'Desequilibrio', cooldown: 'Reutilización', spiritCost: 'Coste de PH', noSkills: 'Este personaje no tiene datos de habilidades', searchEffects: 'Buscar ID de efecto, descripción, personaje o habilidad…', allCategories: 'Todas las categorías', allEffects: 'Todos los efectos', usedOnly: 'Solo usados', unusedOnly: 'Solo no usados', unknownOnly: 'Solo desconocidos', effectsCount: '{shown} / {total} efectos', noEffects: 'No hay efectos coincidentes', undefinedEffect: 'Efecto no definido', openDefinition: 'Abrir definición', moreUsages: '{count} referencias más', localizationMatrix: 'Matriz de localización de nombres', localizationHint: 'Las celdas vacías indican datos ausentes. Haga clic en un personaje para abrir el archivo de idioma.', characterIdColumn: 'Personaje / ID', missing: 'Ausente', searchIssues: 'Buscar diagnósticos…', allSeverities: 'Todas las gravedades', issuesCount: '{shown} / {total} diagnósticos', noIssuesMatch: 'No hay diagnósticos coincidentes', noIssues: 'No se encontraron problemas de datos', openSource: 'Abrir origen', readingCharacterData: 'Leyendo personajes, habilidades, efectos y datos de localización…', skillId: 'ID de habilidad', skillName: 'Nombre de habilidad', skillType: 'Tipo de habilidad', element: 'Elemento', damageMultiplier: 'Multiplicador de daño', staggerValue: 'Valor de desequilibrio', cooldownField: 'Reutilización', spiritCostField: 'Coste de PH', skillDescription: 'Descripción de habilidad', baseEffectsMulti: 'Efectos base (selección múltiple)', enhancementName: 'Nombre de mejora', visibleMarker: 'Marcador de visualización', triggerText: 'Texto de condición del disparador', enhancementDescription: 'Descripción de la mejora', triggerEffectsMulti: 'Dependencias del disparador (selección múltiple)', outputEffectsMulti: 'Efectos de la mejora (selección múltiple)', effectCategory: 'Categoría de efecto', effectId: 'ID de efecto (MAYÚSCULAS_CON_GUIONES_BAJOS)', effectDescription: 'Descripción del efecto', categoryName: 'Nombre de categoría', effectMultiHint: 'Mantenga Ctrl / Cmd para seleccionar varios elementos. Las opciones proceden de effects.py y se agrupan por categoría.', selectedTriggerEffects: '{count} dependencias seleccionadas', noTriggerEffects: 'No se seleccionaron dependencias del disparador', noSelectedEffects: 'No se seleccionaron efectos', unknownEffect: 'Efecto desconocido', unknownCurrentEffect: 'Efecto desconocido en los datos actuales', inferredFromTriggerText: 'Inferido del texto del disparador', clickCopySkillId: 'Haga clic para copiar el ID de habilidad', clickCopyEffectId: 'Haga clic para copiar el ID de efecto', openCharacterLocaleFile: 'Abrir archivo de idioma del nombre del personaje', confirmDelete: '¿Eliminar «{name}»?\nSe creará automáticamente una copia .bak antes de guardar.', copied: 'Copiado: {text}', noTasks: 'No se encontraron tareas.\nConfigure primero la ruta del proyecto.', collapseParameters: 'Contraer parámetros', running: 'En ejecución…', oneTimeTask: 'Una vez', triggerTask: 'Disparador', configGroup: 'Grupo de configuración', commonParameters: 'Parámetros comunes', groupParameters: 'Parámetros del grupo', childTaskConfig: 'Configuración de subtareas', otherParameters: 'Otros parámetros', launchSettings: 'Configuración de inicio', extraArgs: 'Argumentos adicionales', extraArgsHint: 'Admite argumentos entre comillas o una matriz JSON de cadenas.', environmentVariables: 'Variables de entorno', environmentHint: 'Una entrada KEY=VALUE por línea; solo se envía a este proceso.', timeoutSeconds: 'Tiempo límite de parada automática (segundos)', timeoutHint: '0 significa sin límite.', saveParameters: 'Guardar parámetros', reset: 'Restablecer', saveLaunchSettings: 'Guardar configuración de inicio', noConfigParameters: 'No hay parámetros configurables (schema no preparado o sin default_config).', schemaFailed: 'No se pudo recopilar el schema de esta tarea: {error}', holdCtrlMulti: 'Mantenga Ctrl para seleccionar varios elementos', currentValue: '{value} (actual)', selectedOptionsHint: 'Valores disponibles: {values}', structuredJsonHint: 'Matriz JSON que admite objetos de condición y secuencias de acciones.', stopping: 'Deteniendo la tarea…', timeoutStopping: 'La tarea agotó el tiempo; deteniéndola…', taskStopped: 'Tarea detenida. Consulte Salida para obtener detalles.', taskTimedOut: 'La tarea agotó el tiempo y se detuvo. Consulte Salida para obtener detalles.', taskCompleted: 'Tarea completada. Consulte Salida para obtener detalles.', taskFailed: 'La tarea terminó con un error. Consulte Salida para obtener detalles.', templatesHint: 'Clic=insertar · Doble clic=copiar · Pase sobre la miniatura y pulse 👁 para ver el origen', templatesCount: '{shown}/{total} plantillas', noTemplates: 'No se encontraron plantillas.', noTemplateMatch: 'No hay plantillas que coincidan con «{query}».', viewOriginal: 'Ver la imagen original con la posición resaltada', thumbnailStats: '{loaded} miniaturas cargadas', thumbnailStatsWithFailures: '{loaded} miniaturas cargadas / {failed} con error', thumbnailLoadFailed: 'Error al cargar la miniatura', templateSize: 'Tamaño: {width}×{height}', templateSource: 'Origen: {path}',
};

const DICTIONARIES: Record<SupportedUiLocale, WebviewStrings> = {
  'zh-cn': ZH_CN,
  'zh-tw': ZH_TW,
  en: EN,
  ja: JA,
  ko: KO,
  es: ES,
};

export function webviewStrings(language = vscode.env.language): WebviewStrings {
  return DICTIONARIES[uiLocale(language)];
}

export function formatWebviewString(strings: WebviewStrings, key: string, args: Record<string, unknown> = {}): string {
  const template = strings[key] || ZH_CN[key] || key;
  return template.replace(/\{(\w+)\}/g, (_all, name: string) => String(args[name] ?? `{${name}}`));
}

export function injectWebviewLocalization(html: string, marker = '__I18N_JSON__'): string {
  return html.split(marker).join(JSON.stringify(webviewStrings()).replace(/</g, '\\u003c'));
}
