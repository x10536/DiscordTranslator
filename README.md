# Discord 实时翻译助手

给"看不懂外语但想逛 Discord 外文社区"的人做的 Windows 桌面翻译工具。

**鼠标悬停消息 → 原文正上方弹出半透明气泡显示译文，鼠标移开立刻消失。** 不用选中、不用复制、不用切窗口。

---

## 两个版本

本仓库提供两个版本，按需要选一个下载即可：

| 版本 | 名称 | 适合谁 | 核心差异 |
|---|---|---|---|
| **v2.2** | **大陆国人版** | 只想把外文翻成中文的国内用户 | 界面中文，只能翻译成简体中文 |
| **v2.3** | **国际版** | 需要多种语言、或给外国同事用 | 界面支持中/英，可翻译成 **13 种语言** |

### v2.3 国际版新增了什么

- **13 种目标语言**：简体中文 / English / 日本語 / 한국어 / Русский / Español / Français / Deutsch / Português / Italiano / Tiếng Việt / ไทย / العربية
  —— 俄罗斯同事设成俄语就看到俄语，日本人设成日语就看到日语
- **界面语言中/英切换**：外国同事也能看懂设置面板
- **同语言自动跳过**：悬停的内容已经是目标语言时，本地直接判断、不发请求（更快，也省钱）
- **气泡配色 + 透明度可调**：12 色预设 + 取色器 + 透明度滑块 + 实时预览

---

## 下载

到本仓库的 **[Releases](../../releases)** 页面下载：

- `Discord翻译助手_v2.2_公开版.zip` —— 大陆国人版
- `Discord翻译助手_v2.3_公开版.zip` —— 国际版

下载后**解压到任意目录，双击 `launcher.exe`** 即可。无需安装，无需管理员权限。

---

## 快速开始

1. 解压压缩包
2. **先打开 Discord**（保持登录状态）
3. 双击 `launcher.exe`
4. 右键托盘/悬浮球 → **设置** → 填入你的 **DeepSeek API Key** → 保存
5. 回到 Discord，鼠标悬停任意外文消息，译文气泡就会出现

> 本工具需要自己的 DeepSeek API Key（[在这里申请](https://platform.deepseek.com/)）。
> 仓库内的 `dt_config.example.json` 是空白模板，把你的 Key 填进去改名成 `dt_config.json` 也行。

---

## 源码说明

```
v2.2/                    ← 大陆国人版源码
├── inject.js            页面注入脚本（CDP 注入到 Discord）
├── launcher.py          启动器源码（负责开启调试端口 + 转发翻译请求）
├── README.md            该版本详细说明
├── 使用说明.txt          图文式简明说明
└── 方案文档.md           完整技术方案（含踩坑记录，适合给大模型看）

v2.3/                    ← 国际版源码（同上结构）
```

**注意**：源码里**不含** `launcher.exe`（8MB 二进制，已放在 Releases 里）和 `dt_config.json`（含个人 API Key）。想自己打包 exe：

```bash
pip install pyinstaller
pyinstaller --onefile --name launcher --console \
  --add-data "绝对路径/inject.js;." \
  --distpath . --workpath ./build_temp --specpath ./build_temp launcher.py
```

---

## 工作原理（简版）

Discord 是 Electron 应用，普通 Chrome 扩展在它上面不生效。本工具改用 **CDP（Chrome DevTools Protocol）注入**：

1. `launcher.exe` 启动 Discord 时带上 `--remote-debugging-port=9333`
2. 通过 WebSocket 把 `inject.js` 注入页面
3. 页面有 CSP `connect-src` 限制，页面内 `fetch` 外部 API 会被拦
   → 用 `Runtime.addBinding` 注册原生桥接，把翻译请求交给 Python 侧代发

详见各版本目录下的 `方案文档.md`。

---

## English

**Discord Hover Translator** — hover over any message and a translation bubble appears above it. Move away and it disappears.

Two builds are available:

- **v2.2 (Mainland China build)** — Chinese UI, translates into Simplified Chinese only.
- **v2.3 (International build)** — UI in Chinese/English, translates into **13 languages** (Chinese, English, Japanese, Korean, Russian, Spanish, French, German, Portuguese, Italian, Vietnamese, Thai, Arabic), with customizable bubble color and opacity.

Download the zip you need from the **[Releases](../../releases)** page, extract it anywhere, and run `launcher.exe`. You will need your own [DeepSeek API key](https://platform.deepseek.com/).

---

## 许可

仅供个人学习与内部使用。
