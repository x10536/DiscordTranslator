"""
Discord 翻译助手 v2.4 - 启动器（CDP 注入 + 原生桥接）

原理：
1. 用调试端口启动 Discord
2. 通过 Chrome DevTools Protocol 注入翻译脚本（悬浮球 / 气泡 / 悬停翻译）
3. 通过 Runtime.addBinding 注册原生函数 __dtNative，让页面 JS 能"呼叫"本程序

为什么需要第 3 步（桥接）：
Discord 页面设置了 CSP: connect-src，禁止页面 JS 直接请求 api.deepseek.com，
所以在页面里 fetch 会报 "Failed to fetch"。
桥接方案：页面 JS 不直接发网络请求，而是调用本程序的原生函数，
由本程序（Python）代为发起 HTTPS 请求，再把结果送回页面。彻底绕开 CSP。

v2.3 新增：
  · 目标语言可配置（13 种），system prompt 按目标语言动态生成
  · 控制台启动提示跟随"界面语言"设置（中文 / English）

v2.4 新增：
  · 结束 Discord 后轮询确认进程真的退出（不再固定 sleep 3 秒就往下走）
  · 等待主界面超时后自动重试一轮（Discord 有时第一次起不来）
  · 超时报错文案直接点明"可能是防火墙 / 杀毒软件拦了调试接口"，并给出排查顺序
  · 端口已监听但主界面还没渲染时，先等待复用，不急着杀掉重启
  · 调试端口可配置（环境变量 DT_PORT 或 dt_config.json 的 debugPort）
  · 修日志单位：原来打印的"字节"其实是字符数，中文一字 3 字节

注意：本程序需要保持运行，关闭本程序翻译即停止。
      （右键悬浮球 -> 退出翻译助手 可正常退出）
"""

import os
import sys
import time
import json
import ctypes
import subprocess
import urllib.request
import urllib.error

DEFAULT_DEBUG_PORT = 9333
DEBUG_PORT = DEFAULT_DEBUG_PORT     # 运行时会被 resolve_debug_port() 覆盖
WAIT_FIRST = 150                    # 首次等待主界面的秒数
WAIT_RETRY = 90                     # 自动重试时的等待秒数
CREATE_NO_WINDOW = 0x08000000
API_URL = 'https://api.deepseek.com/v1/chat/completions'

# 目标语言（页面传 targetLang 过来，这里翻译成给大模型看的语言名）
TARGET_NAMES = {
    'zh': '简体中文',
    'en': 'English',
    'ja': '日本語',
    'ko': '한국어',
    'ru': 'русский',
    'es': 'español',
    'fr': 'français',
    'de': 'Deutsch',
    'pt': 'português',
    'it': 'italiano',
    'vi': 'Tiếng Việt',
    'th': 'ไทย',
    'ar': 'العربية',
}

# 提示词模板：{target} 会被替换成目标语言名
PROMPT_TEMPLATE = (
    '你是翻译助手。把用户给出的文本翻译成{target}。\n'
    '只返回翻译结果，不要加任何解释、不要加引号、不要加前缀。\n'
    '如果原文已经是{target}，就原样返回，一个字都不要改。\n'
    '如果原文是代码、链接、用户名、纯数字或表情，原样返回。'
)

SYSTEM_PROMPT = PROMPT_TEMPLATE.format(target='简体中文')   # 兼容旧调用

# 控制台提示语（跟随界面语言设置）
CONSOLE_MSG = {
    'zh': {
        'title': 'Discord 翻译助手 v2.4',
        'port': '  调试端口：%d',
        'loaded': '[0/4] 已加载翻译脚本 (%d 字节)',
        'check': '[1/4] 检查现有 Discord...',
        'reuse': '      已检测到带调试接口的 Discord，直接复用',
        'reuse_wait': '      调试端口已监听，等待主界面渲染完成...',
        'kill': '      结束已运行的 Discord...',
        'killed': '      已结束旧进程',
        'notrunning': '      没有运行中的 Discord',
        'noupdate': '[错误] 找不到 Discord (Update.exe)，请确认已安装 Discord 桌面版',
        'launch': '[2/4] 启动 Discord...',
        'launchfail': '[错误] 启动失败: %s',
        'wait': '[3/4] 等待 Discord 主界面（最多 %d 秒）...',
        'login': '      若 Discord 要求登录，请先登录',
        'loaded_main': '      主界面已加载',
        'timeout': '[错误] 等待超时，未检测到 Discord 主界面',
        'timeout_hint': '[!] 最常见的原因：防火墙 / 杀毒软件拦截了调试接口',
        'retry_launch': '      自动重试一次（重新启动 Discord，再等 %d 秒）...',
        'timeout_help1': '[错误] 重试后仍未检测到 Discord 主界面，请按顺序排查：',
        'timeout_help2': '  1) 防火墙 / 杀毒软件（最常见）—— 把 Discord.exe 和本程序加入白名单',
        'timeout_help3': '     360 / 火绒 / Windows Defender 都会拦 127.0.0.1 的调试端口',
        'timeout_help4': '  2) 代理软件（如 v2rayN）是否已开启、能否正常访问 discord.com',
        'timeout_help5': '  3) 若 Discord 要求登录，请先登录后重试',
        'timeout_help6': '  4) 端口 %d 被别的程序占用 —— 可在 dt_config.json 里改 debugPort',
        'proxy': '请确认代理软件（如 v2rayN）已开启且工作正常',
        'inject': '[4/4] 注入翻译脚本并建立翻译通道...',
        'ok': '[成功] 翻译助手已启动！',
        'warn': '[警告] 已注入，但未检测到悬浮球，请查看 Discord 右下角',
        'tip1': '  · Discord 右下角有半透明悬浮球（绿色边框 = 翻译已开启）',
        'tip2': '  · 首次使用：右键悬浮球 → 设置',
        'tip3': '  · 鼠标悬停消息 → 自动翻译成目标语言',
        'tip4': '  · 退出：右键悬浮球 → 退出翻译助手',
        'tip5': '  本窗口将自动隐藏，程序需保持后台运行',
        'noinject': '[错误] 找不到 inject.js',
        'noinject2': '请确保 inject.js 和本程序在同一目录',
        'stop': '[退出] 翻译助手已停止',
        'interrupt': '[退出] 用户中断',
        'disconnect': '[!] 与 Discord 的连接中断：%s',
        'retry': '    3 秒后尝试重新连接（若 Discord 已关闭则退出）...',
        'discordclosed': '[退出] Discord 已关闭，翻译助手结束',
        'presskey': '按回车键退出...',
        'target': '  · 目标语言：%s',
        'bridgefail': '  · [注意] 通道自检未通过，请在 Discord 里按 Ctrl+R 刷新页面',
    },
    'en': {
        'title': 'Discord Translator v2.4',
        'port': '  Debug port: %d',
        'loaded': '[0/4] Translation script loaded (%d bytes)',
        'check': '[1/4] Checking for a running Discord...',
        'reuse': '      Found a Discord with the debug port open - reusing it',
        'reuse_wait': '      Debug port is open - waiting for the main window to render...',
        'kill': '      Closing the running Discord...',
        'killed': '      Old process closed',
        'notrunning': '      No Discord was running',
        'noupdate': '[ERROR] Discord (Update.exe) not found. Is Discord Desktop installed?',
        'launch': '[2/4] Starting Discord...',
        'launchfail': '[ERROR] Failed to start: %s',
        'wait': '[3/4] Waiting for the Discord main window (up to %ds)...',
        'login': '      If Discord asks you to log in, please do so',
        'loaded_main': '      Main window loaded',
        'timeout': '[ERROR] Timed out waiting for the Discord main window',
        'timeout_hint': '[!] Most common cause: a firewall / antivirus is blocking the debug port',
        'retry_launch': '      Retrying once (restarting Discord, waiting %ds more)...',
        'timeout_help1': '[ERROR] Still no Discord main window after the retry. Check in this order:',
        'timeout_help2': '  1) Firewall / antivirus (most common) - whitelist Discord.exe and this program',
        'timeout_help3': '     360 / Huorong / Windows Defender all block the 127.0.0.1 debug port',
        'timeout_help4': '  2) Proxy (e.g. v2rayN) running and able to reach discord.com',
        'timeout_help5': '  3) If Discord asks you to log in, do so and try again',
        'timeout_help6': '  4) Port %d is taken - change debugPort in dt_config.json',
        'proxy': 'Make sure your proxy (e.g. v2rayN) is running',
        'inject': '[4/4] Injecting the script and opening the translation channel...',
        'ok': '[OK] Translator is running!',
        'warn': '[WARN] Injected, but the floating ball was not found - check the bottom-right corner',
        'tip1': '  · A translucent ball sits in the bottom-right corner (green border = ON)',
        'tip2': '  · First time: right-click the ball -> Settings',
        'tip3': '  · Hover any message to translate it into your target language',
        'tip4': '  · To quit: right-click the ball -> Quit translator',
        'tip5': '  This window will hide itself - keep the program running in the background',
        'noinject': '[ERROR] inject.js not found',
        'noinject2': 'Make sure inject.js is in the same folder as this program',
        'stop': '[EXIT] Translator stopped',
        'interrupt': '[EXIT] Interrupted by user',
        'disconnect': '[!] Lost connection to Discord: %s',
        'retry': '    Retrying in 3 seconds (exits if Discord is gone)...',
        'discordclosed': '[EXIT] Discord was closed - translator stopped',
        'presskey': 'Press Enter to exit...',
        'target': '  · Target language: %s',
        'bridgefail': '  · [NOTE] Bridge self-test failed - press Ctrl+R inside Discord',
    },
}

_cmsg = CONSOLE_MSG['zh']

_log_file = None


def set_console_lang(ui_lang):
    """控制台提示语跟随界面语言"""
    global _cmsg
    _cmsg = CONSOLE_MSG.get(ui_lang) or CONSOLE_MSG['zh']


def m(key, *args):
    s = _cmsg.get(key, key)
    return s % args if args else s


def build_system_prompt(target_lang):
    name = TARGET_NAMES.get(target_lang or 'zh', '简体中文')
    return PROMPT_TEMPLATE.format(target=name)


# ==================== 基础工具 ====================

def log(msg):
    print(msg, flush=True)
    if _log_file:
        try:
            _log_file.write(msg + '\n')
            _log_file.flush()
        except Exception:
            pass


def exe_dir():
    if getattr(sys, 'frozen', False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))


def get_inject_js_path():
    """优先从程序同目录读取 inject.js（方便单独更新），否则用打包内置的"""
    local = os.path.join(exe_dir(), 'inject.js')
    if os.path.exists(local):
        return local
    bundled = os.path.join(getattr(sys, '_MEIPASS', exe_dir()), 'inject.js')
    if os.path.exists(bundled):
        return bundled
    return None


def hide_console():
    if os.environ.get('DT_NO_HIDE') == '1':   # 调试用：保留控制台
        return
    try:
        hwnd = ctypes.windll.kernel32.GetConsoleWindow()
        if hwnd:
            ctypes.windll.user32.ShowWindow(hwnd, 0)   # SW_HIDE
    except Exception:
        pass


def show_console():
    try:
        hwnd = ctypes.windll.kernel32.GetConsoleWindow()
        if hwnd:
            ctypes.windll.user32.ShowWindow(hwnd, 5)   # SW_SHOW
    except Exception:
        pass


def clean_env():
    """清除代理环境变量（避免干扰 Discord 启动）"""
    env = os.environ.copy()
    for k in list(env.keys()):
        if k.lower() in ('http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'):
            del env[k]
    return env


def http_get_json(url, timeout=4):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(url, timeout=timeout) as r:
            return json.load(r)
    except Exception:
        return None


# ==================== Discord 进程管理 ====================

def resolve_debug_port():
    """调试端口可配置：环境变量 DT_PORT > dt_config.json 的 debugPort > 默认 9333

    什么情况下需要改：9333 被别的程序占用，或者安全软件专门盯着这个端口拦。
    用法：把 dt_config.json 里加上 "debugPort": "9334"（字符串或数字都行）。
    """
    env = (os.environ.get('DT_PORT') or '').strip()
    if env.isdigit() and 1024 <= int(env) <= 65535:
        return int(env)
    try:
        cfg_port = str(load_config().get('debugPort') or '').strip()
    except Exception:
        cfg_port = ''
    if cfg_port.isdigit() and 1024 <= int(cfg_port) <= 65535:
        return int(cfg_port)
    return DEFAULT_DEBUG_PORT


def discord_pids():
    """返回当前运行中的 Discord.exe 进程号列表（没有则返回 []）"""
    try:
        r = subprocess.run(
            ['tasklist', '/FI', 'IMAGENAME eq Discord.exe', '/NH', '/FO', 'CSV'],
            capture_output=True, creationflags=CREATE_NO_WINDOW)
    except Exception:
        return []
    out = (r.stdout or b'').decode('utf-8', 'ignore')
    pids = []
    for line in out.splitlines():
        line = line.strip()
        if not line.startswith('"'):
            continue
        parts = [p.strip('"') for p in line.split('","')]
        if len(parts) >= 2 and parts[0].lower() == 'discord.exe' and parts[1].isdigit():
            pids.append(parts[1])
    return pids


def port_open(port=None, timeout=2):
    """调试端口是否已经在监听"""
    port = port or DEBUG_PORT
    try:
        with urllib.request.urlopen(
                'http://127.0.0.1:%d/json/version' % port, timeout=timeout) as r:
            return r.status == 200
    except Exception:
        return False


def kill_discord(wait=12):
    """结束所有 Discord 进程，并轮询确认真的退出了。

    为什么要轮询：taskkill 返回成功只说明"命令发出去了"。Discord 是 Electron
    多进程应用，主进程退出后子进程可能还赖几秒，此时端口仍被占着 —— 新实例
    起不来，就会一路走到"等待超时"。早先这里固定 time.sleep(3) 就往下走，
    正是这个问题。
    """
    had = bool(discord_pids())
    if had:
        subprocess.run(['taskkill', '/F', '/IM', 'Discord.exe'],
                       capture_output=True, creationflags=CREATE_NO_WINDOW)

    deadline = time.time() + wait
    while time.time() < deadline and discord_pids():
        time.sleep(0.4)

    if discord_pids():      # 还赖着不走，再强杀一次
        subprocess.run(['taskkill', '/F', '/IM', 'Discord.exe'],
                       capture_output=True, creationflags=CREATE_NO_WINDOW)
        time.sleep(1.0)

    return had and not discord_pids()


def find_update_exe():
    local = os.environ.get('LOCALAPPDATA', '')
    p = os.path.join(local, 'Discord', 'Update.exe')
    return p if os.path.exists(p) else None


def launch_discord():
    """带调试端口启动 Discord；成功返回 True"""
    update_exe = find_update_exe()
    if not update_exe:
        log(m('noupdate'))
        return False
    args = '--remote-debugging-port=%d --remote-allow-origins=*' % DEBUG_PORT
    try:
        subprocess.Popen(
            [update_exe, '--processStart', 'Discord.exe', '--process-start-args', args],
            env=clean_env(), creationflags=CREATE_NO_WINDOW
        )
        return True
    except Exception as e:
        log(m('launchfail', e))
        return False


def find_main_page(timeout=6):
    """查找 Discord 主页面 target

    注意：Discord 还会有 /popout 弹出窗口（弹出的通话/视频/频道），
    它们同样是 type=page 且域名是 discord.com。
    必须优先选 /channels/ 那个，否则会把脚本注入到弹出窗口里。
    """
    start = time.time()
    while time.time() - start < timeout:
        targets = http_get_json('http://127.0.0.1:%d/json/list' % DEBUG_PORT)
        if targets:
            fallback = None
            for t in targets:
                url = t.get('url') or ''
                if t.get('type') != 'page' or 'discord.com' not in url:
                    continue
                if '/channels/' in url:
                    return t
                if fallback is None:
                    fallback = t
            if fallback is not None:
                return fallback
        time.sleep(1)
    return None


def ensure_discord():
    """返回 Discord 主页面 target；必要时重启 Discord"""
    log(m('check'))
    target = find_main_page(timeout=4)
    if target:
        log(m('reuse'))
        return target

    # 端口已经在监听、只是主界面还没渲染出来（上一次启动的 Discord 还在加载中）：
    # 这种情况别急着杀掉重启 —— 杀掉重启反而更慢。
    if port_open():
        log(m('reuse_wait'))
        target = find_main_page(timeout=30)
        if target:
            log(m('reuse'))
            return target

    log(m('kill'))
    killed = kill_discord()
    log(m('killed') if killed else m('notrunning'))

    log(m('launch'))
    if not launch_discord():
        return None

    log(m('wait', WAIT_FIRST))
    log(m('login'))
    target = find_main_page(WAIT_FIRST)
    if target:
        log(m('loaded_main'))
        return target

    # ---- 第一次没等到，自动重试一轮 ----
    # Discord 有时第一次就是起不来（自更新、单实例锁没释放、启动太快被顶掉），
    # 再给一次机会比直接报错友好得多。
    log(m('timeout'))
    log(m('timeout_hint'))
    log(m('retry_launch', WAIT_RETRY))
    kill_discord()
    if not launch_discord():
        return None
    target = find_main_page(WAIT_RETRY)
    if target:
        log(m('loaded_main'))
        return target

    # 两次都不行，把最可能的原因按顺序摆出来（安全软件拦端口排第一）
    log('')
    log(m('timeout_help1'))
    log(m('timeout_help2'))
    log(m('timeout_help3'))
    log(m('timeout_help4'))
    log(m('timeout_help5'))
    log(m('timeout_help6', DEBUG_PORT))
    return None


# ==================== 翻译请求（在本程序内发起，不受页面 CSP 限制）====================

def http_post_json(url, payload, headers, timeout=25):
    """先直连，失败再走系统代理"""
    data = json.dumps(payload).encode('utf-8')
    last_err = None
    for use_proxy in (False, True):
        try:
            if use_proxy:
                opener = urllib.request.build_opener()   # 默认：读取系统代理
            else:
                opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            req = urllib.request.Request(url, data=data, headers=headers, method='POST')
            with opener.open(req, timeout=timeout) as r:
                return r.status, json.loads(r.read().decode('utf-8', 'ignore'))
        except urllib.error.HTTPError as e:
            body = e.read().decode('utf-8', 'ignore')
            try:
                return e.code, json.loads(body)
            except Exception:
                return e.code, {'raw': body}
        except Exception as e:
            last_err = e
    raise last_err


def _map_api_error(status, data):
    msg = ''
    try:
        msg = (data.get('error') or {}).get('message') or ''
    except Exception:
        msg = str(data)[:120]
    if status == 401:
        return 'API Key 无效或已失效，请重新设置'
    if status == 402 or 'Insufficient Balance' in msg:
        return 'DeepSeek 账户余额不足，请到官网充值后再试'
    if status == 429:
        return '请求过于频繁，请稍后再试'
    if status >= 500:
        return 'DeepSeek 服务暂时不可用，请稍后再试'
    return 'API 错误 %d：%s' % (status, msg[:120])


def handle_translate(params):
    api_key = (params.get('apiKey') or '').strip()
    text = (params.get('text') or '').strip()
    model = params.get('model') or 'deepseek-chat'
    target = params.get('targetLang') or 'zh'
    if not api_key:
        return {'ok': False, 'error': '未设置 API Key，请右键悬浮球 → 设置'}
    if not text:
        return {'ok': False, 'error': '没有可翻译的文本'}

    payload = {
        'model': model,
        'messages': [
            {'role': 'system', 'content': build_system_prompt(target)},
            {'role': 'user', 'content': text[:2000]},
        ],
        'temperature': 0.3,
        'max_tokens': 800,
        'stream': False,
    }
    headers = {
        'Authorization': 'Bearer ' + api_key,
        'Content-Type': 'application/json',
    }
    try:
        status, data = http_post_json(API_URL, payload, headers)
    except Exception as e:
        return {'ok': False, 'error': '网络连接失败：%s' % e}

    if status == 200:
        try:
            content = data['choices'][0]['message']['content'].strip()
            return {'ok': True, 'result': content}
        except Exception:
            return {'ok': False, 'error': '返回数据格式异常'}
    return {'ok': False, 'error': _map_api_error(status, data)}


def config_path():
    return os.path.join(exe_dir(), 'dt_config.json')


def load_config():
    p = config_path()
    if os.path.exists(p):
        try:
            with open(p, 'r', encoding='utf-8') as f:
                d = json.load(f)
            if isinstance(d, dict):
                return d
        except Exception as e:
            log('[!] 读取配置失败: %s' % e)
    return {}


def save_config(cfg):
    try:
        with open(config_path(), 'w', encoding='utf-8') as f:
            json.dump(cfg, f, ensure_ascii=False, indent=2)
        return True
    except Exception as e:
        log('[!] 保存配置失败: %s' % e)
        return False


def handle_get_config(params):
    return {'ok': True, 'result': load_config()}


def handle_set_config(params):
    cfg = params.get('config') or {}
    if not isinstance(cfg, dict):
        return {'ok': False, 'error': '配置格式错误'}
    if not save_config(cfg):
        return {'ok': False, 'error': '配置写入失败'}
    return {'ok': True, 'result': 'saved'}


def handle_test(params):
    api_key = (params.get('apiKey') or '').strip()
    if not api_key:
        return {'ok': False, 'error': '请先输入 API Key'}
    payload = {
        'model': params.get('model') or 'deepseek-chat',
        'messages': [{'role': 'user', 'content': 'hi'}],
        'max_tokens': 5,
    }
    headers = {'Authorization': 'Bearer ' + api_key, 'Content-Type': 'application/json'}
    try:
        status, data = http_post_json(API_URL, payload, headers, timeout=20)
    except Exception as e:
        return {'ok': False, 'error': '网络连接失败：%s' % e}
    if status == 200:
        return {'ok': True, 'result': '连接成功'}
    return {'ok': False, 'error': _map_api_error(status, data)}


# ==================== CDP 桥接服务 ====================

class Bridge(object):
    def __init__(self, ws):
        self.ws = ws
        self.mid = 0
        self.events = []       # 待处理的事件
        self.running = True

    def _read(self, timeout):
        self.ws.settimeout(max(0.2, timeout))
        try:
            raw = self.ws.recv()
        except Exception as e:
            if 'timed out' in str(e).lower() or 'Timeout' in type(e).__name__:
                return None
            raise
        if not raw:
            raise IOError('连接已关闭')
        return json.loads(raw)

    def send(self, method, params=None, timeout=30):
        """发送 CDP 命令并等待响应；期间到达的事件存入 self.events"""
        self.mid += 1
        my_id = self.mid
        self.ws.send(json.dumps({'id': my_id, 'method': method, 'params': params or {}}))
        deadline = time.time() + timeout
        while time.time() < deadline:
            msg = self._read(deadline - time.time())
            if msg is None:
                continue
            if msg.get('id') == my_id:
                return msg
            if msg.get('id') is None and msg.get('method'):
                self.events.append(msg)
        raise IOError('CDP 命令超时: %s' % method)

    def dispatch_result(self, rid, result):
        """把翻译结果送回页面"""
        inner = json.dumps(result, ensure_ascii=False)
        expr = 'window.__dtDispatch(%s,%s)' % (json.dumps(rid), json.dumps(inner))
        self.send('Runtime.evaluate', {'expression': expr, 'returnByValue': True}, timeout=15)

    def handle_binding(self, msg):
        p = msg.get('params') or {}
        if p.get('name') != '__dtNative':
            return
        try:
            req = json.loads(p.get('payload') or '{}')
        except Exception:
            return
        rid = req.get('id')
        method = req.get('method')
        params = req.get('params') or {}
        if not rid:
            return

        if method == 'translate':
            result = handle_translate(params)
        elif method == 'test':
            result = handle_test(params)
        elif method == 'getConfig':
            result = handle_get_config(params)
        elif method == 'setConfig':
            result = handle_set_config(params)
        elif method == 'ping':
            result = {'ok': True, 'result': 'pong'}
        elif method == 'quit':
            result = {'ok': True, 'result': 'bye'}
            self.running = False
        else:
            result = {'ok': False, 'error': '未知方法: %s' % method}

        try:
            self.dispatch_result(rid, result)
        except Exception as e:
            log('[!] 回传结果失败: %s' % e)

    def ping_bridge(self, timeout=6):
        """通道自检：页面调用 __dtNative，本程序能否真的收到"""
        try:
            self.send('Runtime.evaluate', {
                'expression': 'typeof window.__dtNative === "function" && '
                              'window.__dtNative(JSON.stringify({id:"__ping__",method:"ping",params:{}})), "sent"',
                'returnByValue': True}, timeout=10)
        except Exception:
            return False

        def hit(msg):
            if msg.get('method') != 'Runtime.bindingCalled':
                return False
            return '__ping__' in ((msg.get('params') or {}).get('payload') or '')

        deadline = time.time() + timeout
        while time.time() < deadline:
            # 注意：bindingCalled 事件常常先于 evaluate 的响应到达，
            # 会被 send() 收进 self.events，这里必须先翻队列，否则会误报"未通过"
            while self.events:
                if hit(self.events.pop(0)):
                    return True
            msg = self._read(min(0.5, max(0.1, deadline - time.time())))
            if msg is None:
                continue
            if hit(msg):
                return True
            if msg.get('method'):
                self.events.append(msg)
        return False

    def serve(self, js_code):
        self.send('Page.enable')
        self.send('Runtime.enable')

        # 先删掉上一次运行残留的绑定属性。
        # 为什么必须删：Runtime.addBinding 装的 __dtNative 是个全局属性，launcher.exe 退出后
        # 属性本身会留在页面里（指向已关闭的旧会话）。此时重启 launcher.exe，因为属性已存在，
        # 新的 addBinding 不会覆盖它 —— 表现就是"程序明明在跑，却一直提示翻译服务响应超时"。
        # 实测：先 delete 再 addBinding，通道立刻恢复，无需刷新页面。
        try:
            self.send('Runtime.evaluate', {
                'expression': 'try{delete window.__dtNative}catch(e){}',
                'returnByValue': True}, timeout=10)
        except Exception:
            pass

        # 注册原生函数（对所有上下文生效，页面刷新后依然可用）
        self.send('Runtime.addBinding', {'name': '__dtNative'})
        # 持久注入（页面刷新后自动重新注入）
        self.send('Page.addScriptToEvaluateOnNewDocument', {'source': js_code})
        # 立即注入当前页面
        self.send('Runtime.evaluate', {'expression': js_code, 'returnByValue': True})

        bridge_ok = self.ping_bridge()

        # 校验悬浮球
        r = self.send('Runtime.evaluate', {
            'expression': '!!document.getElementById("dt-ball")', 'returnByValue': True})
        ok = r.get('result', {}).get('result', {}).get('value')

        log('')
        if ok:
            log(m('ok'))
        else:
            log(m('warn'))
        if not bridge_ok:
            log(m('bridgefail'))

        log('')
        log(m('tip1'))
        log(m('tip2'))
        log(m('tip3'))
        log(m('target', TARGET_NAMES.get(load_config().get('targetLang') or 'zh', '简体中文')))
        log(m('tip4'))
        log('')
        log(m('tip5'))
        time.sleep(2.5)
        hide_console()

        # 主循环：处理页面发来的请求
        while self.running:
            while self.events:
                self.handle_binding(self.events.pop(0))
                if not self.running:
                    return True
            msg = self._read(1.0)
            if msg is None:
                continue
            if msg.get('method'):
                self.events.append(msg)
        return True


def connect_bridge(target, js_code):
    import websocket
    ws = websocket.create_connection(target['webSocketDebuggerUrl'], timeout=20)
    try:
        b = Bridge(ws)
        b.serve(js_code)
    finally:
        try:
            ws.close()
        except Exception:
            pass


# ==================== 主流程 ====================

def main():
    global _log_file, DEBUG_PORT
    try:
        _log_file = open(os.path.join(exe_dir(), 'dt_bridge.log'), 'w', encoding='utf-8')
    except Exception:
        _log_file = None

    DEBUG_PORT = resolve_debug_port()
    set_console_lang(load_config().get('uiLang'))

    log('=' * 52)
    log('     ' + m('title'))
    log('=' * 52)
    log('')
    log(m('port', DEBUG_PORT))
    log('')

    inject_path = get_inject_js_path()
    if not inject_path:
        log(m('noinject'))
        log(m('noinject2'))
        input(m('presskey'))
        return 1
    with open(inject_path, 'r', encoding='utf-8') as f:
        js_code = f.read()
    # 注意：len(str) 数的是"字符"，中文一个字占 3 字节，和文案里的"字节"对不上。
    # 想显示真实文件大小必须按 UTF-8 编码后再数。
    log(m('loaded', len(js_code.encode('utf-8'))))

    target = ensure_discord()
    if not target:
        input(m('presskey'))
        return 1

    log(m('inject'))
    while True:
        try:
            connect_bridge(target, js_code)
            log(m('stop'))
            return 0
        except KeyboardInterrupt:
            log(m('interrupt'))
            return 0
        except Exception as e:
            log(m('disconnect', e))
            log(m('retry'))
            time.sleep(3)
            target = find_main_page(timeout=10)
            if not target:
                log(m('discordclosed'))
                return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as e:
        show_console()
        print('[异常] %s' % e)
        import traceback
        traceback.print_exc()
        input('按回车键退出...')
