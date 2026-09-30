# Discord 实时翻译助手

给"看不懂外语但想逛 Discord 外文社区"的人做的 Windows 桌面翻译工具。

**鼠标悬停消息 → 原文正上方弹出半透明气泡显示译文，鼠标移开立刻消失。** 不用选中、不用复制、不用切窗口。

---

## 三个版本

按需要选一个下载即可。**没有特殊理由的话，直接下 v2.4。**

| 版本 | 名称 | 适合谁 | 核心差异 |
|---|---|---|---|
| **v2.4** | **国际版（最新，推荐）** | **所有人** | 在 v2.3 基础上修掉悬浮球跑丢、启动偶发失败、设置"假成功"等问题 |
| v2.3 | 国际版 | 需要多种语言、或给外国同事用 | 界面支持中/英，可翻译成 **13 种语言** |
| v2.2 | 大陆国人版 | 只想把外文翻成中文的国内用户 | 界面中文，只能翻译成简体中文 |

### v2.4 修了什么

v2.4 **没有加新功能**，全部是修真实使用中暴露出来的问题：

- **悬浮球不再跑丢**：位置改成按「距右下角的距离」记录。
  以前存的是绝对坐标，窗口最大化时把球拖到右下角、再还原窗口，球就跑到可视区外看不见了
- **启动更快、更少重启 Discord**：已有带调试接口的 Discord 会直接复用；
  端口已开但主界面还没渲染完时会先等一等，而不是急着杀掉重启
- **等待超时会自动重试一轮**：Discord 有时第一次起不来（自更新、单实例锁没释放）
- **排错更直白**：超时报错会直接点明「可能是防火墙 / 杀毒软件拦了调试接口」，并给出排查顺序
- **调试端口可配置**：`dt_config.json` 里加 `"debugPort": "9334"` 即可换端口
- **保存设置不再"假成功"**：配置写不进 `dt_config.json` 时会明确提示
  「设置已生效，但没存进文件，重启会丢」，而不是照旧弹「设置已保存」

### v2.3 国际版新增了什么

- **13 种目标语言**：简体中文 / English / 日本語 / 한국어 / Русский / Español / Français / Deutsch / Português / Italiano / Tiếng Việt / ไทย / العربية
  —— 俄罗斯同事设成俄语就看到俄语，日本人设成日语就看到日语
- **界面语言中/英切换**：外国同事也能看懂设置面板
- **同语言自动跳过**：悬停的内容已经是目标语言时，本地直接判断、不发请求（更快，也省钱）
- **气泡配色 + 透明度可调**：12 色预设 + 取色器 + 透明度滑块 + 实时预览

---

## 下载

到本仓库的 **[Releases](../../releases)** 页面下载：

- `Discord翻译助手_v2.4_公开版.zip` —— **国际版（最新，推荐）**
- `Discord翻译助手_v2.3_公开版.zip` —— 国际版
- `Discord翻译助手_v2.2_公开版.zip` —— 大陆国人版

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

## ⚠️ 遇到问题先看这条：Discord 正常但没有悬浮球

**这是目前最常见的求助，原因基本都是同一个：防火墙 / 杀毒软件拦住了调试接口。**

本工具靠 `127.0.0.1:9333` 这个本地调试端口注入界面。安全软件把它拦掉之后，
**Discord 本身用起来完全正常，就是右下角不出现悬浮球** —— 现象特别迷惑人。

正确做法是**加白名单**（不要长期关着杀毒软件）：

1. 在安全软件的「信任区 / 排除项」里**同时**加入 `Discord.exe` 和 `launcher.exe`
   - 360：设置 → 信任区 → 添加文件 / 目录
   - 火绒：防护中心 → 信任区
   - Windows Defender：病毒和威胁防护 → 排除项 → 添加排除项
2. Windows 防火墙里允许 `Discord.exe` 通过（勾「专用网络」即可）
3. 重新双击 `launcher.exe`

公司电脑如果有统一的安全管控策略，找 IT 同事把这两个程序加进放行名单。

> 排查时先看 `launcher.exe` 同目录的 `dt_bridge.log`，它按 `[0/4]` ～ `[4/4]` 打点，
> 直接指出卡在哪一步。卡在 `[3/4]` 基本就是安全软件拦端口。

各版本目录下的 `README.md` / `使用说明.txt` 里有更完整的常见问题。

---

## 源码说明

```
v2.4/                    ← 国际版最新源码（推荐从这里看）
├── inject.js            页面注入脚本（CDP 注入到 Discord）
├── launcher.py          启动器源码（负责开启调试端口 + 转发翻译请求）
├── README.md            该版本详细说明
├── 使用说明.txt          图文式简明说明
├── 方案文档.md           完整技术方案（含踩坑记录，适合给大模型看）
└── dt_config.example.json  配置模板（把 Key 填进去改名成 dt_config.json 即可用）

v2.3/                    ← 国际版源码（同上结构）
v2.2/                    ← 大陆国人版源码（同上结构）
```

**注意**：源码里**不含** `launcher.exe`（8MB 二进制，已放在 Releases 里）和 `dt_config.json`（含个人 API Key）。想自己打包 exe：

```bash
pip install pyinstaller
pyinstaller --onefile --console --name launcher \
  --distpath ./dist --workpath ./build_temp --specpath ./build_temp launcher.py
```

> **不要加 `--add-data`**：`inject.js` 是**故意放在 exe 外面**的 ——
> `launcher.py` 的 `get_inject_js_path()` 优先读 exe 同目录，
> 这样以后只改界面就能直接替换 `inject.js`，不用重新打包。
> 也别用 `--windowed`：`--console` 才能让同事在出错时看到报错信息。

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

Three builds are available — **just grab v2.4 unless you have a reason not to**:

- **v2.4 (International, latest, recommended)** — everything in v2.3, plus fixes for the floating ball drifting off-screen when the window is resized, occasional startup failures, and a "fake success" message when saving settings.
- **v2.3 (International build)** — UI in Chinese/English, translates into **13 languages** (Chinese, English, Japanese, Korean, Russian, Spanish, French, German, Portuguese, Italian, Vietnamese, Thai, Arabic), with customizable bubble color and opacity.
- **v2.2 (Mainland China build)** — Chinese UI, translates into Simplified Chinese only.

Download the zip you need from the **[Releases](../../releases)** page, extract it anywhere, and run `launcher.exe`. You will need your own [DeepSeek API key](https://platform.deepseek.com/).

---

## 许可

仅供个人学习与内部使用。
