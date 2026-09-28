"""
Discord 翻译助手 v2.2 - 启动器（CDP 注入 + 原生桥接）

原理：
1. 用调试端口启动 Discord
2. 通过 Chrome DevTools Protocol 注入翻译脚本（悬浮球 / 气泡 / 悬停翻译）
3. 通过 Runtime.addBinding 注册原生函数 __dtNative，让页面 JS 能"呼叫"本程序

为什么需要第 3 步（桥接）：
Discord 页面设置了 CSP: connect-src，禁止页面 JS 直接请求 api.deepseek.com，
所以在页面里 fetch 会报 "Failed to fetch"。
桥接方案：页面 JS 不直接发网络请求，而是调用本程序的原生函数，
由本程序（Python）代为发起 HTTPS 请求，再把结果送回页面。彻底绕开 CSP。

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

DEBUG_PORT = 9333
CREATE_NO_WINDOW = 0x08000000
API_URL = 'https://api.deepseek.com/v1/chat/completions'
SYSTEM_PROMPT = ('你是翻译助手。将用户给出的英文翻译成自然流畅的简体中文。'
                 '只返回翻译结果，不加任何解释、不加引号、不加前缀。'
                 '如果原文是代码、链接、用户名或已是中文，原样返回。')

_log_file = None


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

def kill_discord():
    r = subprocess.run(['taskkill', '/F', '/IM', 'Discord.exe'],
                       capture_output=True, creationflags=CREATE_NO_WINDOW)
    time.sleep(3)
    return r.returncode == 0


def find_update_exe():
    local = os.environ.get('LOCALAPPDATA', '')
    p = os.path.join(local, 'Discord', 'Update.exe')
    return p if os.path.exists(p) else None


def find_main_page(timeout=6):
    """查找 Discord 主页面 target"""
    start = time.time()
    while time.time() - start < timeout:
        targets = http_get_json('http://127.0.0.1:%d/json/list' % DEBUG_PORT)
        if targets:
            for t in targets:
                url = t.get('url') or ''
                if t.get('type') == 'page' and 'discord.com' in url:
                    return t
        time.sleep(1)
    return None


def ensure_discord():
    """返回 Discord 主页面 target；必要时重启 Discord"""
    log('[1/4] 检查现有 Discord...')
    target = find_main_page(timeout=4)
    if target:
        log('      已检测到带调试接口的 Discord，直接复用')
        return target

    log('      结束已运行的 Discord...')
    killed = kill_discord()
    log('      ' + ('已结束旧进程' if killed else '没有运行中的 Discord'))

    update_exe = find_update_exe()
    if not update_exe:
        log('[错误] 找不到 Discord (Update.exe)，请确认已安装 Discord 桌面版')
        return None

    log('[2/4] 启动 Discord...')
    args = '--remote-debugging-port=%d --remote-allow-origins=*' % DEBUG_PORT
    try:
        subprocess.Popen(
            [update_exe, '--processStart', 'Discord.exe', '--process-start-args', args],
            env=clean_env(), creationflags=CREATE_NO_WINDOW
        )
    except Exception as e:
        log('[错误] 启动失败: %s' % e)
        return None

    log('[3/4] 等待 Discord 主界面（最多 150 秒）...')
    log('      若 Discord 要求登录，请先登录')
    target = find_main_page(150)
    if not target:
        log('[错误] 等待超时，未检测到 Discord 主界面')
        log('请确认代理软件（如 v2rayN）已开启且工作正常')
        return None
    log('      主界面已加载')
    return target


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
    if not api_key:
        return {'ok': False, 'error': '未设置 API Key，请右键悬浮球 → 设置 API Key'}
    if not text:
        return {'ok': False, 'error': '没有可翻译的文本'}

    payload = {
        'model': model,
        'messages': [
            {'role': 'system', 'content': SYSTEM_PROMPT},
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

    def serve(self, js_code):
        self.send('Page.enable')
        self.send('Runtime.enable')
        # 注册原生函数（对所有上下文生效，页面刷新后依然可用）
        self.send('Runtime.addBinding', {'name': '__dtNative'})
        # 持久注入（页面刷新后自动重新注入）
        self.send('Page.addScriptToEvaluateOnNewDocument', {'source': js_code})
        # 立即注入当前页面
        self.send('Runtime.evaluate', {'expression': js_code, 'returnByValue': True})

        # 校验悬浮球
        r = self.send('Runtime.evaluate', {
            'expression': '!!document.getElementById("dt-ball")', 'returnByValue': True})
        ok = r.get('result', {}).get('result', {}).get('value')

        log('')
        if ok:
            log('[成功] 翻译助手已启动！')
        else:
            log('[警告] 已注入，但未检测到悬浮球，请查看 Discord 右下角')

        log('')
        log('  · Discord 右下角有半透明悬浮球（绿色边框 = 翻译已开启）')
        log('  · 首次使用：右键悬浮球 → 设置 API Key')
        log('  · 鼠标悬停英文消息 → 自动显示中文翻译')
        log('  · 退出：右键悬浮球 → 退出翻译助手')
        log('')
        log('  本窗口将自动隐藏，程序需保持后台运行')
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
    global _log_file
    try:
        _log_file = open(os.path.join(exe_dir(), 'dt_bridge.log'), 'w', encoding='utf-8')
    except Exception:
        _log_file = None

    log('=' * 52)
    log('     Discord 翻译助手 v2.2')
    log('=' * 52)
    log('')

    inject_path = get_inject_js_path()
    if not inject_path:
        log('[错误] 找不到 inject.js')
        log('请确保 inject.js 和本程序在同一目录')
        input('按回车键退出...')
        return 1
    with open(inject_path, 'r', encoding='utf-8') as f:
        js_code = f.read()
    log('[0/4] 已加载翻译脚本 (%d 字节)' % len(js_code))

    target = ensure_discord()
    if not target:
        input('按回车键退出...')
        return 1

    log('[4/4] 注入翻译脚本并建立翻译通道...')
    while True:
        try:
            connect_bridge(target, js_code)
            log('[退出] 翻译助手已停止')
            return 0
        except KeyboardInterrupt:
            log('[退出] 用户中断')
            return 0
        except Exception as e:
            log('[!] 与 Discord 的连接中断：%s' % e)
            log('    3 秒后尝试重新连接（若 Discord 已关闭则退出）...')
            time.sleep(3)
            target = find_main_page(timeout=10)
            if not target:
                log('[退出] Discord 已关闭，翻译助手结束')
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
