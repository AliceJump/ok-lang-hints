# ok-script Lang Hints

面向 ok-script 项目的 VS Code 辅助扩展，为 Python 代码中的语言键和图像模板提供可视化提示。

## 功能

### `self.lang` 语言键

- 输入 `self.lang.`：补全语言模块。
- 输入 `self.lang.<模块>.`：补全语言键，并在补全详情中显示当前语言的值。
- 行内显示值：`string` 使用 `「值」`，`pattern` 使用 `~值~`，避免混淆两种类型。
- hover 显示所有支持语言的表格：`zh_CN`、`zh_TW`、`en_US`、`ja_JP`、`ko_KR`、`es_ES`。
- 自动回退当前语言 → `zh_CN` → 第一个可用语言。

### `fL` / `FeatureList` 模板

- 输入 `fL.` 或 `FeatureList.`：补全 COCO 标注中的模板名称。
- 模板补全项显示模板尺寸。
- hover 模板名称显示由 COCO `bbox` 从原图裁剪的缩略图、尺寸、来源和坐标。
- 模板图片在扩展激活时后台预热并缓存，hover 和补全详情避免重复解码 4K 原图。
- 标注或模板 PNG 变化后自动清理缓存并重新预热；批量文件变化使用防抖处理。

扩展只针对 `python` 文件生效，不修改源代码，也不生成存根文件。

## 数据来源

默认从当前工作区读取：

- `assets/lang/*.json`：语言数据，节点格式为 `{ "string": "..." }` 或 `{ "pattern": "..." }`。
- `assets/coco_annotations.json`：模板名称、原图和 `bbox`。
- `assets/images/*.png`：模板预览使用的原图。
- 如果存在，也会读取 `ok_tasks/assets/coco_annotations.json` 与 `ok_tasks/assets/images/*.png`。

保存 JSON、COCO 标注或 PNG 后，扩展会自动刷新，无需重启项目。

## 安装

方式一（打包安装，推荐）：

```bash
cd ok-lang-hints
npm install
npm run compile
npx @vscode/vsce package --allow-missing-repository
```

然后在 VS Code 中：`Ctrl+Shift+P` → **Extensions: Install from VSIX...** → 选择生成的 `ok-lang-hints-0.1.0.vsix`。

方式二（开发调试）：

用 VS Code 打开本项目根目录，按 `F5`（使用 `ok-lang-hints/.vscode/launch.json` 的配置）启动扩展开发宿主，在宿主窗口打开任意 Python 文件即可看到效果。

## 配置

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `okLangHints.langDirectory` | `assets/lang` | lang JSON 目录（相对工作区根） |
| `okLangHints.displayLocale` | `auto` | 幽灵注释显示的语言；`auto` 跟随 VS Code UI 语言 |
| `okLangHints.enableInlayHints` | `true` | 是否启用幽灵注释 |
| `okLangHints.featureAliases` | `["fL", "FeatureList"]` | 模板别名列表；别名会用于模板补全和 hover 识别 |

### 配置示例

在工作区的 `.vscode/settings.json` 中：

```json
{
	"okLangHints.langDirectory": "assets/lang",
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
