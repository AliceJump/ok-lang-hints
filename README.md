# ok-script Lang Hints

面向 ok-script 项目的 VS Code 辅助扩展，为 Python 代码中的语言键和图像模板提供可视化提示。

## 功能

### `self.lang` 语言键

- 输入 `self.lang.`：补全语言模块。
- 输入 `self.lang.<模块>.`：补全语言键，并在补全详情中显示当前语言的值。
- 行内显示值：`string` 使用 `「值」`，`pattern` 使用 `~值~`，避免混淆两种类型。
- hover 显示所有支持语言的表格：`zh_CN`、`zh_TW`、`en_US`、`ja_JP`、`ko_KR`、`es_ES`。
- 自动回退当前语言 → `zh_CN` → 第一个可用语言。

### OCR 函数 `match` 参数（`ocr.po` 修正）

- 在 `ocr` / `wait_ocr` / `wait_click_ocr` / `find_boxes` 等函数的 `match` 参数位置，若传入正则对象 `re.compile(r"...")`（也支持字符串/列表），悬停可查看该 pattern 在 `ocr.po` 中的全部语言修正映射。
- 行内显示修正后的值：如 `match=re.compile(r"体力.*")` 后显示幽灵注释 `→ 体力[0-9]+`。
- 在 `re.compile(r"` 或 `match="` 的引号内输入，可补全 `ocr.po` 中的 key（含自动生成的去空格副本）。

### 技能效果 ID（`EffectType.XXX` / `"effect_id": "XXX"`）

针对《明日方舟：终末地》技能数据库（`src/data/effects.py` 的 `EffectType` 枚举与 `EFFECT_DESCRIPTIONS`），提供效果 ID 的中文描述提示：

- **hover**：悬停 `EffectType.XXX` 或字符串字面量 `"XXX"`（如 `"effect_id": "ATTACH_COLD"`），显示效果 ID、分类与中文描述。
- **幽灵注释**：在 `EffectType.XXX` 或 `"effect_id": "XXX"` 之后行内显示中文描述，如 `「敌人被施加寒冷元素」`。
- **补全**：在 `effect_id: "` 或 `effect: "` 的引号内输入，补全全部效果 ID，详情显示 `[分类] 描述`。
- 数据从 `src/data/effects.py` 实时解析（按 mtime 增量刷新），`EffectType` 成员与 `EFFECT_DESCRIPTIONS` 中的描述自动对齐，无需手动维护。
- 自动排除 `self.lang.*` 与 OCR `match=re.compile(...)` 等字符串场景，避免误报。

### `fL` / `FeatureList` 模板

- 输入 `fL.` 或 `FeatureList.`：补全 COCO 标注中的模板名称。
- 模板补全项显示模板尺寸。
- hover 模板名称显示由 COCO `bbox` 从原图裁剪的缩略图、尺寸、来源和坐标。
- 模板图片在扩展激活时后台预热并缓存，hover 和补全详情避免重复解码 4K 原图。
- 标注或模板 PNG 变化后自动清理缓存并重新预热；批量文件变化使用防抖处理。

### ok-script 任务启动器

- 从目标项目的 `src/config.py` / `config.py` 安全解析一次性任务和触发任务。
- 后台采集任务的运行时 `config`、`default_config`、`config_type`、说明、运行时名称与任务类型，并按字段并集生成完整参数表单。
- 任务名、说明、参数名、分组名和选项标签会读取目标项目 `i18n/<locale>/LC_MESSAGES/ok.po` 显示翻译；原始配置 key、默认值和选项值始终保持不变，保存与运行不会写入翻译文本。
- 支持布尔、数字、文本、多行文本、下拉、多选、列表、项目级联下拉和结构化条件序列。
- 读取 `default_config_group` / `register_config_groups` 生成递归可折叠的子任务配置树；普通 `sub_configs` 继续按当前值动态显隐。
- 每个项目、每个任务独立保存参数覆盖；覆盖仅对启动的子进程生效，不写回目标项目的 `configs/*.json`。
- 可为单个任务设置额外命令行参数、环境变量和自动停止超时。
- 运行日志输出到 **ok-script 任务启动** 输出频道，并支持停止整个子进程树。

### 角色技能管理面板

执行命令 **ok-script Lang Hints: 打开角色技能管理面板**，可在编辑器区打开角色数据库总览：

- 左侧按星级、元素、职业、技能类型、强化组和诊断状态筛选角色。
- 角色列表和详情页直接复用模板面板已经落盘的 96px 模板缩略图；缺失或加载失败时回退角色首字。
- 右侧集中展示角色基础信息、名称多语言、技能说明、倍率、失衡、冷却、技力、基础效果和强化组效果。
- 强化组同时展示触发条件、触发依赖效果、强化产出效果和可见脉冲标记。
- 效果标签优先显示 `assets/lang/effect_names.json` 中与插件界面语言匹配的名称，同时保留原始效果 ID 作为副信息和定位键。
- 可直接添加自定义技能，并对自定义技能执行修改、删除；同步技能不可删除，且 ID、名称、类别、元素、描述保持只读，只开放数值、基础效果和强化组修改。
- 可对任意技能添加、修改、删除强化组；基础效果、触发依赖效果和强化产出效果均从 `effects.py` 按类别多选，不需要手写效果 ID。
- 效果索引支持添加效果类别和添加效果定义；新增效果会同时维护 `EffectType` 与 `EFFECT_DESCRIPTIONS`。
- 写入前自动生成 `.bak`，通过临时文件校验后原子替换源 JSON/Python 文件。
- 效果索引按 `effects.py` 分类汇总，并反向列出每个效果被哪些角色、技能和强化组引用。
- 名称本地化页使用类似字符串资源编辑器的矩阵，横向比较全部 locale，突出缺失名称。
- 数据诊断检查角色主表/技能文件覆盖、重复技能 ID、未知效果 ID、强化声明不一致和缺失语言等问题。
- 角色 JSON、语言文件、效果定义和诊断位置均可一键在编辑器中打开；源文件保存后面板自动刷新。
- 角色管理面板采用独立的 HTML 外壳、CSS 视觉层和 JavaScript 交互层，便于分别维护结构、样式与行为。

### 插件界面语言

- 扩展清单、通知、输出频道、hover、模板面板、任务启动器、工具箱和角色技能管理面板均支持简体中文、繁体中文、英文、日文、韩文和西班牙文。
- 侧边栏分为两个独立容器：**ok-script 工具**（工具箱 + 任务启动）和 **ok-script 模板**（模板面板 + 模板素材），各自显示独立的视图名称。
- 插件 UI 默认跟随 VS Code 显示语言；其他语言回退英文。角色名称矩阵和项目业务数据仍使用目标项目自身的 locale 与原始协议值。

### 模板面板（可视化浏览全部模板）

两种打开方式：

1. **侧边栏视图（推荐）**：点击左侧活动栏的"ok-script 模板"图标，即可展开模板面板（包含模板面板和模板素材两个视图）；也可执行命令 **ok-script Lang Hints: 打开模板面板**（快捷键 `Ctrl+Alt+T`）聚焦该视图。
2. **编辑器大窗口**：执行命令 **ok-script Lang Hints: 在编辑器中打开模板面板（大窗口）**，在编辑器区打开更大的网格视图。

面板功能：

- 网格展示工作区全部模板的缩略图（按 COCO `bbox` 从原图裁剪，与 hover 预览一致）。
- 每张卡片显示模板名称与尺寸；悬停可查看名称、尺寸、`bbox` 坐标和来源图片路径。
- 顶部搜索框实时按名称过滤，并显示匹配数量。
- **单击卡片**：把 `fL.<模板名>` 插入到最近活动的 Python 编辑器光标处（别名跟随 `okLangHints.featureAliases` 配置的第一项）。
- **双击卡片**：复制 `fL.<模板名>` 到剪贴板。
- **点击缩略图**：打开来源原图。
- 标注 / 模板图片变化后自动刷新面板内容，无需手动重开。

扩展只针对 `python` 文件生效，不修改源代码，也不生成存根文件。

## 数据来源

默认从当前工作区读取：

- `assets/lang/*.json`：语言数据，节点格式为 `{ "string": "..." }` 或 `{ "pattern": "..." }`。
- `i18n/<locale>/LC_MESSAGES/*.po`：gettext PO 数据（`okLangHints.enablePoData` 控制，默认开启）。仅加载 `okLangHints.poDomains` 白名单内的 domain（默认 `ocr`，排除 `ok.po` 等 UI 通用文案）。`msgid`（如 `借 款 金 额`、`体力.*`）作为 key，`msgstr` 作为对应语言的 `string` 值；含空格的 `msgid` 会自动生成去空格副本（`借款金额`）。该数据用于 OCR 函数 `match` 参数的提示，不作为 `self.lang` 模块。
- `assets/coco_annotations.json`：模板名称、原图和 `bbox`。
- `assets/images/*.png`：模板预览使用的原图。
- 如果存在，也会读取 `ok_tasks/assets/coco_annotations.json` 与 `ok_tasks/assets/images/*.png`。
- `src/data/effects.py`：技能效果 ID 数据源（`EffectType` 枚举 + `EFFECT_DESCRIPTIONS` 中文描述），用于 `EffectType.XXX` / `"effect_id": "XXX"` 的提示。
- `assets/lang/effect_names.json`：角色技能管理面板中的效果本地化名称；缺失时回退到效果描述和原始 ID。

保存 JSON（包括效果名称）、COCO 标注、PNG 或 `effects.py` 后，扩展会自动刷新，无需重启项目。

## 项目结构

```text
src/                         VS Code 扩展宿主 TypeScript 源码
media/
	icons/                     活动栏与视图图标（templates.svg、toolbox.svg、task.svg）
	annotationPanel/           标注编辑器 Webview（index.html、CSS、交互脚本）
	templateAssetPanel/        模板素材管理 Webview（index.html、CSS、交互脚本）
	templateGallery/           模板面板 Webview（index.html、CSS、交互脚本）
	taskLauncher/              任务启动器 Webview（index.html、CSS、组件脚本）
	characterManager/          角色技能管理 Webview（index.html、CSS、交互脚本）
	pngCropWorker.ts           Worker 线程：sharp 原生图像裁剪
python/                      随扩展发布的任务发现、探测与执行辅助脚本
scripts/                     开发期生成与回归测试工具，不打入 VSIX
l10n/                        扩展宿主运行时本地化资源
package.nls*.json            扩展清单本地化资源
out/                         TypeScript 编译产物（由构建生成）
```

每个外置 Webview 的 HTML、CSS 和 JavaScript 均放在同一功能目录中；宿主通过 CSP 限制和 `asWebviewUri()` 加载资源。

## JetBrains / PyCharm 版本

仓库的 `jetbrains/` 目录包含独立的 Kotlin + IntelliJ Platform 插件工程，当前最低支持 PyCharm / IntelliJ Platform 2025.1（需要 Python 支持）。首版已提供：

- `self.lang`、OCR `match`、模板名称和效果 ID 的补全与快速文档。
- Python / JSON 效果与语言值行内提示。
- 可搜索的原生模板工具窗口，可插入、复制表达式或打开来源图片。
- 项目级数据目录、locale、模板别名和提示开关设置。

构建与安装：

```bash
cd jetbrains
./gradlew test buildPlugin verifyPluginStructure verifyPluginConfiguration
```

Windows 使用 `gradlew.bat`。生成的 ZIP 位于 `jetbrains/build/distributions/`，可在 JetBrains IDE 的 **Settings / Plugins / Install Plugin from Disk...** 中安装。详细状态和后续移植范围见 `jetbrains/README.md`。

## 安装

方式一（打包安装，推荐）：

```bash
cd ok-lang-hints
npm install
npm run compile
npx @vscode/vsce package --allow-missing-repository
```

然后在 VS Code 中：`Ctrl+Shift+P` → **Extensions: Install from VSIX...** → 选择生成的 `ok-lang-hints-0.5.0.vsix`。

方式二（开发调试）：

用 VS Code 打开本项目根目录，按 `F5`（使用 `ok-lang-hints/.vscode/launch.json` 的配置）启动扩展开发宿主，在宿主窗口打开任意 Python 文件即可看到效果。

## 自动发布

- Pull Request 和 `main` 推送只运行 `CI`，同时测试并打包 VS Code 与 JetBrains 两端，不会发布。
- **发布的唯一触发方式是推送一个尚不存在的 `vX.Y.Z` 标签**。工作流不提供手动发布，也不会因 `main` 推送自动发布。
- `package.json`、`package-lock.json` 和 `jetbrains/gradle.properties` 的版本必须完全一致；标签必须等于 `v<version>`。
- 标签工作流会测试两端，构建 VSIX 和 JetBrains ZIP，在同一个 GitHub Release 中上传两个安装包，然后按已配置的 Secret 发布两个 Marketplace。
- GitHub Release 使用仓库内置 `GITHUB_TOKEN`；Marketplace 所需 Secret 统一配置在父仓库 `AliceJump/ok-lang-hints`，子仓库不保存发布凭据。

发布示例：

```bash
# 一次更新 package.json、package-lock.json 和 JetBrains pluginVersion
npm run version:sync -- 0.6.0
npm test

# 先提交并推送子仓库版本
git -C jetbrains add .
git -C jetbrains commit -m "chore(release): prepare v0.6.0"
git -C jetbrains push origin main

# 再提交父仓库版本和新的子模块指针
git add package.json package-lock.json jetbrains
git commit -m "chore(release): prepare v0.6.0"
git push origin main

# 只有这一步会触发发布
git tag -a v0.6.0 -m "Release v0.6.0"
git push origin v0.6.0
```

标签必须是首次推送的新标签；不要移动、覆盖或强制推送已发布标签。若构建失败，应修复代码、提升为新版本并推送新标签，而不是复用旧标签。

需要的仓库 Secrets：

| Secret | 获取方式 | 是否必需 |
|---|---|---|
| `VSCE_PAT` | Visual Studio Marketplace 发布 PAT | 可选；可改用 OIDC Trusted Publishing |
| `JETBRAINS_PUBLISH_TOKEN` | JetBrains Marketplace 作者页 → My Tokens | 发布 JetBrains Marketplace 时必需 |
| `JETBRAINS_PRIVATE_KEY` | JetBrains 插件签名用 PEM 私钥全文或 Base64 | JetBrains Marketplace 发布时必需 |
| `JETBRAINS_PRIVATE_KEY_PASSWORD` | 生成私钥时设置的密码 | JetBrains Marketplace 发布时必需 |
| `JETBRAINS_CERTIFICATE_CHAIN` | 与私钥配套的 `chain.crt` 全文或 Base64 | JetBrains Marketplace 发布时必需 |

在 GitHub 仓库进入 **Settings → Secrets and variables → Actions → New repository secret**，逐项添加。缺少 Marketplace Secret 时，GitHub Release 仍会创建，对应商店发布会跳过；若设置了 JetBrains Token 但签名 Secret 不完整，工作流会失败以避免上传未签名插件。

启用 VS Marketplace OIDC 时，另在 **Actions → Variables → New repository variable** 添加 `VSCE_USE_OIDC=true`；只有完成 Marketplace Trusted Publishing policy 后才启用。

完整的 Token 获取、签名密钥生成和逐次发布步骤见 [RELEASING.md](RELEASING.md)。

## 配置

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `okLangHints.langDirectory` | `assets/lang` | lang JSON 目录（相对工作区根） |
| `okLangHints.poDirectory` | `i18n` | gettext PO 目录（相对工作区根），按 `<locale>/LC_MESSAGES/*.po` 扫描 |
| `okLangHints.enablePoData` | `true` | 是否启用 gettext PO 数据源，与 lang JSON 合并 |
| `okLangHints.poDomains` | `["ocr"]` | 要加载的 PO domain 白名单（默认只加载 ocr，排除 ok 等 UI 文案） |
| `okLangHints.displayLocale` | `auto` | 幽灵注释显示的语言；`auto` 跟随 VS Code UI 语言 |
| `okLangHints.enableInlayHints` | `true` | 是否启用幽灵注释 |
| `okLangHints.featureAliases` | `["fL", "FeatureList"]` | 模板别名列表；别名会用于模板补全和 hover 识别 |
| `okLangHints.effectsFile` | `src/data/effects.py` | 技能效果 ID 定义文件（`EffectType` 枚举与 `EFFECT_DESCRIPTIONS`），相对工作区根目录 |
| `okLangHints.okScriptProjectPath` | 空 | 任务启动器使用的 ok-script 项目根目录；为空时尝试使用当前工作区 |
| `okLangHints.okScriptPython` | 空 | 任务启动器使用的 Python；为空时优先使用目标项目 `.venv/Scripts/python.exe` |
| `okLangHints.characterProjectPath` | 空 | 角色技能管理面板的数据项目；为空时使用 `okScriptProjectPath` 或当前工作区 |
| `okLangHints.characterMasterFile` | `assets/data/characters.json` | 角色主表 JSON |
| `okLangHints.characterSkillsDirectory` | `assets/data/character_skills` | 角色技能 JSON 目录 |
| `okLangHints.characterLocaleFile` | `assets/lang/characters.json` | 角色名称多语言 JSON |
| `okLangHints.characterAvatarTemplateRegex` | `^battle[_-]?icon[_-]?` | 角色头像模板名正则；有捕获组时使用第一组，否则使用匹配前缀后的剩余名称，与角色主表英文 slug 匹配；默认兼容 `battleicon`、`battle_icon` 和 `battle-icon` 前缀 |

**命令**：

| 命令 | 快捷键 | 说明 |
|---|---|---|
| `ok-script Lang Hints: 打开模板面板` | `Ctrl+Alt+T`（macOS `Cmd+Alt+T`） | 聚焦活动栏中的模板侧边栏视图 |
| `ok-script Lang Hints: 在编辑器中打开模板面板（大窗口）` | — | 在编辑器区打开大窗口网格视图 |
| `ok-script Lang Hints: 打开角色技能管理面板` | — | 打开角色、技能、效果、强化组和名称本地化管理页 |

### 配置示例

在工作区的 `.vscode/settings.json` 中：

```json
{
	"okLangHints.langDirectory": "assets/lang",
	"okLangHints.poDirectory": "i18n",
	"okLangHints.poDomains": ["ocr"],
	"okLangHints.displayLocale": "zh_CN",
	"okLangHints.enableInlayHints": true,
	"okLangHints.featureAliases": ["fL", "FeatureList"]
}
```

`displayLocale` 支持 `auto`、`zh_CN`、`zh_TW`、`en_US`、`ja_JP`、`ko_KR` 和 `es_ES`。hover 仍会显示完整语言表格；该设置只影响行内提示和语言补全详情。

如果项目使用了其他变量名，例如 `featureList`，可以配置：

```json
{
	"okLangHints.featureAliases": ["fL", "FeatureList", "featureList"]
}
```

示例效果：在代码中

```python
self.wait_click_ocr(match=self.lang.zip_line_mixin.k_2f4f4a2f, ...)
```

幽灵注释会在 `k_2f4f4a2f` 后面显示 `「向目标移动」`；hover 会弹出包含 zh_CN / zh_TW / en_US / ja_JP / ko_KR / es_ES 全部值的表格。

模板示例：

```python
self.wait_click_feature(feature=fL.give_gift, time_out=10)
```

悬停 `fL.give_gift` 可查看对应模板裁剪图；输入 `fL.` 可从模板名称列表中选择。

## 更新后不生效

安装或直接覆盖扩展文件后执行：

`Ctrl+Shift+P` → **Developer: Reload Window**

如果刚修改了扩展的 `package.json` 配置声明，必须 reload 窗口后设置项才会出现在设置界面中。
