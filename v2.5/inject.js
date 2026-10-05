/**
 * inject.js - Discord 翻译助手（CDP 注入版）v2.5
 * 通过 Chrome DevTools Protocol 注入到 Discord 页面运行
 * 不依赖 Chrome 扩展机制
 *
 * v2.3 新增：
 *   1. 界面语言（中文 / English）—— 外国同事也能看懂菜单和设置
 *   2. 目标语言（13 种）—— 想翻成什么语言就翻成什么语言
 *   3. 同语言不翻译 —— 悬停文本已是目标语言时，直接不发请求（更快）
 *   4. 气泡调色板 + 透明度滑块
 *
 * v2.4 新增：
 *   1. 悬浮球位置改用"距右 / 距下"记录 —— 窗口放大或还原都不会跑丢
 *      （以前存的是 left/top 绝对坐标，最大化下拖到右下角、还原后就看不见了）
 *   2. 保存设置不再"假成功" —— 写不进 dt_config.json 时会明确报错，
 *      而不是照旧弹「设置已保存」
 *
 * v2.5 新增（自动聊天翻译）：
 *   1. 聊天区来了新消息就自动出翻译气泡，贴在消息上方、跟着滚动一起走
 *      —— 最多同时保留 6 条，第 7 条进来时最旧的那条淡出
 *   2. 自动气泡和"鼠标悬停翻译"是两套独立实例，互不干扰；
 *      已经有自动气泡的消息，鼠标再移上去不会再弹悬浮气泡
 *   3. 翻译请求走串行队列，避免频道一活跃就瞬间打出十几个请求
 *   4. 首次使用会有一段两步引导（小手 → 悬浮球 → 高亮自动翻译开关）
 *   5. 自动翻译默认关闭，开关状态存 dt_config.json
 *
 * v2.5 实测后的调整（用户反馈）：
 *   1. **只翻当前屏幕里看得见的消息** —— 屏幕外翻了也没人看，
 *      气泡还会被夹到视口边缘、一堆挤在顶部/底部
 *   2. 滚动时消息滚出视口 → 气泡**立刻撤掉，不做淡出**（否则会堆在窗口顶上）
 *   3. 气泡水平居中对齐到**文字本身**，不是整行容器 ——
 *      容器是块级占满整行，短句子的气泡会飘到右边的空白处，看不出翻的是哪句
 *   4. 气泡**最多停留 15 秒**，过期自动淡出（看过了就别一直杵在句子上方）
 *   5. 刚打开频道时 Discord 还在滚到底部 → 延迟 500ms 再首次扫描，
 *      并且滚动停下后会补翻"刚滚进视口的新消息"
 *   6. **带"回复引用"的消息只翻正文，不翻引用预览** ——
 *      Discord 把引用预览排在正文之前、还复用了 message-content-<被引用ID>，
 *      结果同一条消息被翻两遍（见 autoTextElOf）
 */

(function () {
  'use strict';

  if (window.__DT_INJECTED__) {
    console.log('[DT] 已注入，跳过');
    return;
  }
  window.__DT_INJECTED__ = true;
  window.__DT_VERSION__ = 'v2.5';

  // 只在最外层文档创建界面。
  // 原因：CDP 的 Page.addScriptToEvaluateOnNewDocument 会把脚本注入到页面里的
  // 每一个 iframe，不只是主文档。如果不加这个判断，Discord 里内嵌的网页内容
  // （活动 / 从 Discord 启动的小游戏，比如 Roblox）里面也会冒出一个悬浮球。
  let isTopFrame = false;
  try {
    isTopFrame = (window.top === window.self);
  } catch (e) {
    isTopFrame = false;   // 跨域 iframe 访问 window.top 会抛异常，按非顶层处理
  }
  if (!isTopFrame) {
    console.log('[DT] 当前处于内嵌框架，跳过界面注入');
    return;
  }

  // ===== 可选语言 =====
  // code 是内部标识，name 是原生写法（下拉框里显示），en 是英文名（写进 prompt 备用）
  const LANGUAGES = [
    { code: 'zh', name: '简体中文', en: 'Simplified Chinese' },
    { code: 'en', name: 'English', en: 'English' },
    { code: 'ja', name: '日本語', en: 'Japanese' },
    { code: 'ko', name: '한국어', en: 'Korean' },
    { code: 'ru', name: 'Русский', en: 'Russian' },
    { code: 'es', name: 'Español', en: 'Spanish' },
    { code: 'fr', name: 'Français', en: 'French' },
    { code: 'de', name: 'Deutsch', en: 'German' },
    { code: 'pt', name: 'Português', en: 'Portuguese' },
    { code: 'it', name: 'Italiano', en: 'Italian' },
    { code: 'vi', name: 'Tiếng Việt', en: 'Vietnamese' },
    { code: 'th', name: 'ไทย', en: 'Thai' },
    { code: 'ar', name: 'العربية', en: 'Arabic' }
  ];

  function langName(code) {
    for (let i = 0; i < LANGUAGES.length; i++) {
      if (LANGUAGES[i].code === code) return LANGUAGES[i].name;
    }
    return '简体中文';
  }

  // ===== 界面文案 =====
  const I18N = {
    zh: {
      appName: 'Discord 翻译助手',
      statusOn: '翻译功能已开启',
      statusOff: '翻译功能已关闭',
      bridgeOn: '翻译服务已连接',
      bridgeOff: '翻译服务未连接',
      bridgeHintOn: '（请求由本机代发，已绕开页面限制）',
      bridgeHintOff: '（请重新运行 launcher.exe）',
      turnOn: '开启翻译',
      turnOff: '关闭翻译',
      settings: '设置',
      clearCache: '清空翻译缓存',
      collapse: '收起悬浮球',
      expand: '展开悬浮球',
      quit: '退出翻译助手',
      about: '关于 v2.5',
      toastOn: '翻译已开启',
      toastOff: '翻译已关闭',
      toastCollapsed: '已收起，双击小点展开',
      toastExpanded: '已展开',
      toastCacheCleared: '翻译缓存已清空',
      toastQuit: '翻译助手已退出',
      toastNoBridgeQuit: '翻译服务未连接，可直接关闭 launcher.exe 窗口',
      toastEnterKey: '请先输入 API Key',
      toastKeyOk: 'API Key 有效，连接正常！',
      toastSaved: '设置已保存',
      toastSaveFail: '设置已生效，但没存进文件，重启会丢：',
      testing: '测试中',
      test: '测试',
      aboutText: 'Discord 翻译助手 v2.5 | 悬停翻译 + 自动聊天翻译',
      translating: '正在翻译…',
      errNoKey: '未设置 API Key，请右键悬浮球 → 设置',
      errNoBridge: '翻译服务未连接，请重新运行 launcher.exe',
      errGeneric: '翻译失败',
      errBridgeData: '桥接返回数据异常',
      errBridgeCall: '桥接调用失败: ',
      errTimeout: '翻译服务响应超时，请检查 launcher.exe 是否在运行',
      errUnknown: '未知错误',
      settingsTitle: 'Discord 翻译助手 v2.5 · 设置',
      secUiLang: '界面语言',
      secTarget: '目标语言',
      targetHint: '鼠标悬停的文本只要不是这个语言，就自动翻译成它',
      secApiKey: 'DeepSeek API Key',
      keyHelp: '获取：platform.deepseek.com 注册后创建',
      secColor: '气泡颜色',
      customColor: '自定义',
      secOpacity: '气泡透明度',
      secDelay: '触发延迟',
      secAuto: '自动聊天翻译',
      autoOn: '开启自动翻译',
      autoOff: '关闭自动翻译',
      autoHint: '只翻当前屏幕里的新消息，最多同时保留 6 条，{s} 秒后自动消失',
      toastAutoOn: '自动翻译已开启',
      toastAutoOff: '自动翻译已关闭',
      guideTitle: '新增自动聊天翻译功能',
      guideStep1: '右键点一下悬浮球',
      guideStep2: '在这里打开「自动翻译」',
      guideSkip: '知道了',
      preview: '预览',
      previewText: '这是翻译气泡的预览效果',
      save: '保存设置',
      close: '关闭',
      savedTip: '设置已保存到 dt_config.json'
    },
    en: {
      appName: 'Discord Translator',
      statusOn: 'Translation is ON',
      statusOff: 'Translation is OFF',
      bridgeOn: 'Service connected',
      bridgeOff: 'Service not connected',
      bridgeHintOn: '(requests are sent by the local app)',
      bridgeHintOff: '(please run launcher.exe again)',
      turnOn: 'Turn translation ON',
      turnOff: 'Turn translation OFF',
      settings: 'Settings',
      clearCache: 'Clear translation cache',
      collapse: 'Collapse ball',
      expand: 'Expand ball',
      quit: 'Quit translator',
      about: 'About v2.5',
      toastOn: 'Translation ON',
      toastOff: 'Translation OFF',
      toastCollapsed: 'Collapsed — double-click the dot to expand',
      toastExpanded: 'Expanded',
      toastCacheCleared: 'Translation cache cleared',
      toastQuit: 'Translator stopped',
      toastNoBridgeQuit: 'Service not connected — you can just close launcher.exe',
      toastEnterKey: 'Please enter your API key first',
      toastKeyOk: 'API key is valid — connection OK!',
      toastSaved: 'Settings saved',
      toastSaveFail: 'Applied, but not saved to file - it will be lost on restart: ',
      testing: 'Testing',
      test: 'Test',
      aboutText: 'Discord Translator v2.5 | Hover + auto chat translation',
      translating: 'Translating…',
      errNoKey: 'No API key — right-click the ball → Settings',
      errNoBridge: 'Service not connected — please run launcher.exe again',
      errGeneric: 'Translation failed',
      errBridgeData: 'Bad data returned from bridge',
      errBridgeCall: 'Bridge call failed: ',
      errTimeout: 'Service timed out — is launcher.exe still running?',
      errUnknown: 'Unknown error',
      settingsTitle: 'Discord Translator v2.5 · Settings',
      secUiLang: 'Interface language',
      secTarget: 'Target language',
      targetHint: 'Anything hovered that is not in this language gets translated into it',
      secApiKey: 'DeepSeek API Key',
      keyHelp: 'Create one at platform.deepseek.com',
      secColor: 'Bubble color',
      customColor: 'Custom',
      secOpacity: 'Bubble opacity',
      secDelay: 'Hover delay',
      secAuto: 'Auto chat translation',
      autoOn: 'Turn auto-translate ON',
      autoOff: 'Turn auto-translate OFF',
      autoHint: 'Only new messages on screen - up to 6 bubbles, each fades after {s}s',
      toastAutoOn: 'Auto-translate ON',
      toastAutoOff: 'Auto-translate OFF',
      guideTitle: 'New: auto chat translation',
      guideStep1: 'Right-click the floating ball',
      guideStep2: 'Turn it on here',
      guideSkip: 'Got it',
      preview: 'Preview',
      previewText: 'This is how the translation bubble looks',
      save: 'Save settings',
      close: 'Close',
      savedTip: 'Saved to dt_config.json'
    }
  };

  function t(key) {
    const pack = I18N[CONFIG.uiLang] || I18N.zh;
    return (pack && pack[key]) || I18N.zh[key] || key;
  }

  // ===== 配置存储 =====
  // 注意：Discord 桌面版的"主世界"上下文里没有 localStorage，
  // 所以配置以 launcher.exe 侧的 dt_config.json 为准，页面侧只做内存缓存。
  const CONFIG_DEFAULTS = {
    apiKey: '',
    enabled: '1',
    debounce: '300',
    opacity: '0.75',
    model: 'deepseek-chat',
    ballX: '',               // 旧字段（距左坐标）—— 仅用于兼容老配置
    ballY: '',               // 旧字段（距上坐标）
    ballRight: '',           // 悬浮球距右边距离（推荐，窗口缩放不会跑丢）
    ballBottom: '',          // 悬浮球距下边距离
    uiLang: 'zh',            // 界面语言
    targetLang: 'zh',        // 目标语言
    bubbleBg: '#000000',     // 气泡背景色
    autoTranslate: '0',      // 自动聊天翻译（v2.5）—— 默认关，用户自己开
    autoTtl: '15000',        // 单条自动气泡最长停留毫秒数（v2.5）
    guideDone: ''            // 首次使用引导是否已看过（v2.5）
  };
  const CONFIG = Object.assign({}, CONFIG_DEFAULTS);
  const MEM = {};

  function storeGet(key) {
    try {
      const v = localStorage.getItem('dt_' + key);
      return v === null ? undefined : v;
    } catch (e) {
      return MEM[key];
    }
  }

  function storeSet(key, val) {
    MEM[key] = val;
    try { localStorage.setItem('dt_' + key, val); } catch (e) { /* 主世界无 localStorage，忽略 */ }
  }

  // ===== 原生桥接 =====
  // Discord 页面有 CSP: connect-src 限制，页面里 fetch 外部 API 会直接
  // 报 "Failed to fetch"。所以把网络请求交给外部的 launcher.exe（Python）
  // 代发：通过 CDP Runtime.addBinding 注册的原生函数 __dtNative 通信。
  const NATIVE = (function () {
    const pending = {};
    let seq = 0;

    function available() {
      return typeof window.__dtNative === 'function';
    }

    // launcher.exe 把结果回调到这里
    window.__dtDispatch = function (id, payloadJson) {
      const p = pending[id];
      if (!p) return;
      delete pending[id];
      let data;
      try {
        data = JSON.parse(payloadJson);
      } catch (e) {
        p.reject(new Error(t('errBridgeData')));
        return;
      }
      if (data && data.ok) p.resolve(data.result);
      else p.reject(new Error((data && data.error) || t('errUnknown')));
    };

    function call(method, params, timeoutMs) {
      return new Promise(function (resolve, reject) {
        if (!available()) {
          reject(new Error('__NO_BRIDGE__'));
          return;
        }
        const id = 'r' + (++seq) + '_' + Date.now();
        pending[id] = { resolve: resolve, reject: reject };
        try {
          window.__dtNative(JSON.stringify({ id: id, method: method, params: params || {} }));
        } catch (e) {
          delete pending[id];
          reject(new Error(t('errBridgeCall') + e.message));
          return;
        }
        setTimeout(function () {
          if (pending[id]) {
            delete pending[id];
            reject(new Error(t('errTimeout')));
          }
        }, timeoutMs || 40000);
      });
    }

    return { call: call, available: available };
  })();

  // ===== 全局状态 =====
  let translationEnabled = true;
  let apiKey = '';
  let debounceDelay = 300;
  let bubbleOpacity = 0.75;
  let bubbleBg = '#000000';
  let bubbleState = 'ok';
  let autoTranslateOn = false;   // v2.5：自动聊天翻译开关（从配置读）
  let autoTtlMs = 15000;         // v2.5：单条自动气泡最长停留时间（从配置读，默认见 AUTO_TTL_MS）

  let debounceTimer = null;
  let hideTimer = null;
  let loadingTimer = null;
  let currentHoverEl = null;
  const cache = new Map();
  const CACHE_MAX = 1000;
  const inFlight = new Map();

  // ===== 颜色工具 =====
  function hexToRgb(hex) {
    let h = String(hex || '#000000').replace('#', '').trim();
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (!/^[0-9a-fA-F]{6}$/.test(h)) h = '000000';
    const n = parseInt(h, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  function rgbaStr(hex, alpha) {
    const c = hexToRgb(hex);
    return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + alpha + ')';
  }

  function isLightColor(hex) {
    const c = hexToRgb(hex);
    return (0.299 * c.r + 0.587 * c.g + 0.114 * c.b) > 150;
  }

  function textColors() {
    const light = isLightColor(bubbleBg);
    return {
      ok: light ? '#111214' : '#FFFFFF',
      loading: light ? 'rgba(17,18,20,.55)' : 'rgba(255,255,255,.62)',
      error: light ? '#B3261E' : '#FFB4B4'
    };
  }

  // ===== 配置同步（读写 launcher.exe 的 dt_config.json）=====
  let configReady = Promise.resolve();

  function applyConfig() {
    translationEnabled = CONFIG.enabled !== '0';
    autoTranslateOn = CONFIG.autoTranslate === '1';
    const ttl = parseInt(CONFIG.autoTtl, 10);
    autoTtlMs = (isNaN(ttl) || ttl < 1000) ? AUTO_TTL_MS : ttl;
    apiKey = CONFIG.apiKey || '';
    const d = parseInt(CONFIG.debounce, 10);
    debounceDelay = isNaN(d) ? 300 : d;
    const o = parseFloat(CONFIG.opacity);
    bubbleOpacity = isNaN(o) ? 0.75 : Math.max(0.1, Math.min(1, o));
    if (CONFIG.uiLang !== 'zh' && CONFIG.uiLang !== 'en') CONFIG.uiLang = 'zh';
    if (!CONFIG.targetLang) CONFIG.targetLang = 'zh';
    if (!/^#[0-9a-fA-F]{6}$/.test(CONFIG.bubbleBg || '')) CONFIG.bubbleBg = '#000000';
    bubbleBg = CONFIG.bubbleBg;

    if (ballEl) {
      ballEl.title = t('appName');
      updateBallState();
      // 配置（含悬浮球位置）可能在 createBall 之后才异步加载完，这里补一次定位
      if (!dragging) applyBallPosition();
    }
    updateBubbleStyle();
    syncAutoTranslate();   // 配置变了，自动翻译跟着启停
  }

  function loadConfig() {
    Object.keys(CONFIG_DEFAULTS).forEach(function (k) {
      const v = storeGet(k);
      if (v !== undefined) CONFIG[k] = v;
    });
    applyConfig();
    if (!NATIVE.available()) return Promise.resolve();
    return NATIVE.call('getConfig', {}, 8000).then(function (cfg) {
      if (cfg && typeof cfg === 'object') {
        Object.keys(CONFIG_DEFAULTS).forEach(function (k) {
          if (cfg[k] !== undefined && cfg[k] !== null) CONFIG[k] = String(cfg[k]);
        });
        Object.keys(CONFIG_DEFAULTS).forEach(function (k) { storeSet(k, CONFIG[k]); });
      }
      applyConfig();
    }).catch(function () { /* 桥接不可用时用本地兜底 */ });
  }

  // 保存配置。返回 Promise —— 调用方必须按结果提示，别当成必然成功。
  //
  // 为什么不再 .catch(function(){}) 吞掉异常：
  //   dt_config.json 可能因为"文件只读 / 装在 Program Files 没写权限 / 磁盘满"写不进去。
  //   早先这里把失败吞了，调用方又无条件弹「设置已保存」→ 用户以为存住了，重启才发现全丢。
  //   这种"假成功"比直接报错更坑，所以现在如实把失败抛给调用方。
  //
  // 注意：这里不做回滚。配置在内存里已经生效（本次会话照常用新设置），
  //      只是没能持久化，由调用方提示"重启会丢"。
  function saveConfig(patch) {
    Object.keys(patch).forEach(function (k) {
      CONFIG[k] = String(patch[k]);
      storeSet(k, CONFIG[k]);
    });
    applyConfig();
    // 桥接不可用 = 根本写不到 dt_config.json，这次保存是无效的，如实报错
    if (!NATIVE.available()) return Promise.reject(new Error(t('errNoBridge')));
    return NATIVE.call('setConfig', { config: CONFIG }, 8000);
  }

  // 后台静默保存（拖拽落点、开关状态这类用户没主动点"保存"的操作）：
  // 失败只在控制台留痕、不弹提示打扰人，但绝不静默"成功" —— 出问题时 F12 里能查到。
  function saveConfigQuiet(patch) {
    return saveConfig(patch).catch(function (err) {
      try {
        console.warn('[DiscordTranslator] 配置未能写入 dt_config.json：',
                     (err && err.message) || err);
      } catch (e) { /* 忽略 */ }
    });
  }

  // ==================== 语言识别（决定"要不要翻"）====================
  // 思路：
  //   1. 先用"字符脚本"判断 —— 中文/日文/韩文/俄文/泰文/阿拉伯文 各有专属字符集，非常准
  //   2. 剩下的拉丁字母文本，用"虚词打分"区分 英/西/法/德/葡/意/越
  //   3. 识别结果 == 目标语言 → 不翻译（不发请求，省时省钱）
  //   4. 识别不出（太短、纯数字、纯表情）→ 交给大模型，模型判断已是目标语言会原样返回，
  //      页面再比对"译文 == 原文"就不显示气泡
  const SCRIPT_RE = {
    hangul: /[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/g,
    kana: /[\u3040-\u309F\u30A0-\u30FF]/g,
    cjk: /[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF]/g,
    cyrillic: /[\u0400-\u04FF\u0500-\u052F]/g,
    arabic: /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/g,
    thai: /[\u0E00-\u0E7F]/g,
    latin: /[A-Za-z\u00C0-\u024F]/g
  };

  // 越南语专属字符（đ ă â ê ô ơ ư 及声调符号）
  const VI_RE = /[\u1EA0-\u1EF9\u0102\u0103\u0110\u0111\u01A0\u01A1\u01AF\u01B0]/;

  const STOPWORDS = {
    en: ('the and is are was were you your this that with have has had not but what from they will ' +
         'can about there which when been would their them these those into than then some more ' +
         'other just only also very much many such does did doing how why who whom whose here where ' +
         'all any because should could our its if out up get make know think want need see come take ' +
         'good new time day way people thing work well back even still after before over under again ' +
         'every both few most while during without because between welcome thanks thank please hello ' +
         'hey yeah sorry great nice sure bye wow lol ok yes').split(' '),
    es: ('que los las una uno para con por como pero sus este esta esto estas estoy hay muy sin sobre ' +
         'entre cuando donde tambien mas todo todos toda desde hasta porque puede tiene tienen son ' +
         'del al se lo nosotros ellos ellas ser estar hacer eres soy hola buenos buenas dias noches ' +
         'gracias bien mal aqui ahora nada algo alguien nunca siempre despues antes tambien').split(' '),
    fr: ('les des une est que qui dans pour pas vous avec sur ce cette ces sont plus mais nous ils ' +
         'elles etre avoir fait tout tous toute comme aussi leur leurs aux du au et ne se sa son ses ' +
         'votre notre quand comment pourquoi je tu il elle on suis es sommes etes tres bien merci ' +
         'bonjour salut rien quelque jamais toujours apres avant maintenant ici').split(' '),
    de: ('der die das und ist ein eine einen einem nicht mit sich auf fur von dem den des sind auch ' +
         'aber wird werden kann konnen noch nur uber wie wenn dass wir sie ihre ihr diese dieser ' +
         'dieses zum zur beim durch nach bei aus ich du er es bin bist habe hast haben hatte sehr ' +
         'gut geht ihnen danke bitte hallo guten tag was wer wo warum oder doch schon mussen wollen ' +
         'sollen nichts etwas immer nie danach vorher jetzt hier').split(' '),
    pt: ('que nao uma para com por como mas seus este esta isso sao muito tambem mais todo todos ' +
         'toda desde porque pode tem foi ser das dos pelo pela ao os as um numa quando onde voce ' +
         'voces eles elas seu sua nosso eu tu ele ela nos sou estou somos obrigado ola bom boa dia ' +
         'noite nada algo sempre nunca depois antes agora aqui').split(' '),
    it: ('che non una per con del come ma sono questo questa anche piu tutto tutti tutta suo sua ' +
         'gli delle degli nel nella quando dove perche puo ha essere stato stata loro noi voi io tu ' +
         'lui lei sei siamo siete molto bene grazie ciao buongiorno buonasera niente qualcosa sempre ' +
         'mai dopo prima adesso qui').split(' '),
    vi: ('cua va la co khong duoc trong nguoi nhung cho mot cac voi nay de khi nhu da se cung phai ' +
         'tren tu do thi minh ban chung toi ho rat anh chi em roi nua gi sao the nao dau day kia ' +
         'duoc cung mot').split(' ')
  };
  const STOPWORD_SETS = {};
  Object.keys(STOPWORDS).forEach(function (k) {
    STOPWORD_SETS[k] = new Set(STOPWORDS[k]);
  });

  const TOKEN_SPLIT_RE = /[^\u0041-\u005A\u0061-\u007A\u00C0-\u024F\u1E00-\u1EFF]+/;

  // 去掉变音符号，让 "của"→"cua"、"más"→"mas"、"über"→"uber" 能对上词表
  function stripAccents(s) {
    try {
      return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/\u0111/g, 'd').replace(/\u0110/g, 'D');
    } catch (e) {
      return String(s);
    }
  }

  function countMatches(text, re) {
    const m = text.match(re);
    return m ? m.length : 0;
  }

  function detectLatinLang(text) {
    const tokens = stripAccents(String(text).toLowerCase())
      .split(TOKEN_SPLIT_RE).filter(function (s) { return s.length > 0; });
    if (!tokens.length) return null;
    let best = null, bestScore = 0;
    Object.keys(STOPWORD_SETS).forEach(function (code) {
      const set = STOPWORD_SETS[code];
      let n = 0;
      for (let i = 0; i < tokens.length; i++) {
        if (set.has(tokens[i])) n++;
      }
      if (n > bestScore) { bestScore = n; best = code; }
    });
    if (!best) return null;
    // 短句（≤4 个词）放宽一点：命中 1 个虚词就算认出来
    if (tokens.length <= 4) return bestScore >= 1 ? best : null;
    // 长句要求：至少命中 2 个虚词，且占比不低于 12%
    return (bestScore >= 2 && (bestScore / tokens.length) >= 0.12) ? best : null;
  }

  function detectLang(text) {
    if (!text) return null;
    const s = String(text);
    // 去掉表情符号，避免干扰
    const clean = s.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\uFE0F\u200D]/gu, ' ');
    const letters = countMatches(clean, SCRIPT_RE.latin) + countMatches(clean, SCRIPT_RE.cjk) +
                    countMatches(clean, SCRIPT_RE.cyrillic) + countMatches(clean, SCRIPT_RE.hangul) +
                    countMatches(clean, SCRIPT_RE.kana) + countMatches(clean, SCRIPT_RE.arabic) +
                    countMatches(clean, SCRIPT_RE.thai);
    if (letters < 2) return null;

    const hangul = countMatches(clean, SCRIPT_RE.hangul);
    const kana = countMatches(clean, SCRIPT_RE.kana);
    const cjk = countMatches(clean, SCRIPT_RE.cjk);
    const cyr = countMatches(clean, SCRIPT_RE.cyrillic);
    const ara = countMatches(clean, SCRIPT_RE.arabic);
    const tha = countMatches(clean, SCRIPT_RE.thai);
    const lat = countMatches(clean, SCRIPT_RE.latin);

    // 有假名 → 日语
    if (kana > 0) return 'ja';
    // 有谚文 → 韩语
    if (hangul / letters > 0.3) return 'ko';
    // 有汉字且没有假名 → 中文（日文纯汉字的情况极少，忽略）
    if (cjk / letters > 0.3) return 'zh';
    if (cyr / letters > 0.3) return 'ru';
    if (ara / letters > 0.3) return 'ar';
    if (tha / letters > 0.3) return 'th';
    if (lat / letters > 0.5) {
      if (VI_RE.test(clean)) return 'vi';
      return detectLatinLang(clean);
    }
    return null;
  }

  // 已经是目标语言 → 不用翻
  function isAlreadyTarget(text) {
    const detected = detectLang(text);
    return !!detected && detected === CONFIG.targetLang;
  }

  // 一个字母都没有（纯数字 / 纯表情 / 纯符号）→ 没得翻
  function hasLetters(text) {
    return /[\p{L}]/u.test(text);
  }

  // ==================== 翻译模块 ====================

  function getCached(text) {
    const key = CONFIG.targetLang + '\u0000' + text;
    if (cache.has(key)) {
      const v = cache.get(key);
      cache.delete(key);
      cache.set(key, v);
      return v;
    }
    return null;
  }

  function setCache(text, translation) {
    const key = CONFIG.targetLang + '\u0000' + text;
    if (cache.size >= CACHE_MAX) {
      cache.delete(cache.keys().next().value);
    }
    cache.set(key, translation);
  }

  async function doTranslate(text) {
    await configReady;
    if (!apiKey) {
      throw new Error(t('errNoKey'));
    }
    if (!NATIVE.available()) {
      throw new Error(t('errNoBridge'));
    }
    // 走 launcher.exe 代发请求（绕开页面 CSP）
    return await NATIVE.call('translate', {
      apiKey: apiKey,
      text: text.substring(0, 2000),
      model: CONFIG.model || 'deepseek-chat',
      targetLang: CONFIG.targetLang || 'zh'
    }, 40000);
  }

  function normalize(s) {
    return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  // ==================== 气泡模块 ====================

  let bubbleEl = null;
  let bubbleTargetEl = null;
  let bubbleHideTimer = null;

  function updateBubbleStyle() {
    if (!bubbleEl) return;
    const light = isLightColor(bubbleBg);
    bubbleEl.style.background = rgbaStr(bubbleBg, bubbleOpacity);
    bubbleEl.style.border = '1px solid ' + (light ? 'rgba(0,0,0,.10)' : 'rgba(255,255,255,.10)');
    bubbleEl.style.boxShadow = light
      ? '0 6px 18px rgba(0,0,0,.22)'
      : '0 4px 12px rgba(0,0,0,.45)';
    applyBubbleTextStyle(bubbleState);
    if (bubbleTargetEl) positionBubble(bubbleTargetEl);
  }

  function applyBubbleTextStyle(state) {
    bubbleState = state;
    const txt = document.getElementById('dt-bubble-text');
    if (!txt) return;
    const c = textColors();
    const isError = state === 'error';
    const isLoading = state === true || state === 'loading';
    txt.style.color = isError ? c.error : (isLoading ? c.loading : c.ok);
    txt.style.fontStyle = isLoading ? 'italic' : 'normal';
    txt.style.fontWeight = isError ? '600' : '400';
  }

  function ensureBubble() {
    if (bubbleEl) return;
    bubbleEl = document.createElement('div');
    bubbleEl.id = 'dt-bubble';
    bubbleEl.style.cssText = [
      'position:fixed',
      'z-index:2147483646',
      'display:none',
      'max-width:400px',
      'min-width:80px',
      'background:' + rgbaStr(bubbleBg, bubbleOpacity),
      'border-radius:8px',
      'padding:10px 14px',
      'box-shadow:0 4px 12px rgba(0,0,0,.4)',
      'opacity:0',
      'transition:opacity .15s ease-in-out',
      'font-family:"Microsoft YaHei","PingFang SC",system-ui,sans-serif',
      'font-size:14px',
      'line-height:1.5',
      'color:#fff',
      'word-wrap:break-word',
      'overflow-wrap:break-word',
      'pointer-events:none',
      '-webkit-font-smoothing:antialiased'
    ].join(';');
    const arrow = document.createElement('div');
    arrow.id = 'dt-bubble-arrow';
    arrow.style.cssText = 'position:absolute;width:0;height:0;border-left:8px solid transparent;border-right:8px solid transparent;';
    bubbleEl.appendChild(arrow);
    const txt = document.createElement('div');
    txt.id = 'dt-bubble-text';
    bubbleEl.appendChild(txt);
    document.body.appendChild(bubbleEl);
    updateBubbleStyle();
  }

  function positionBubble(targetEl) {
    if (!bubbleEl || !targetEl) return;
    const rect = targetEl.getBoundingClientRect();
    const br = bubbleEl.getBoundingClientRect();
    let top = rect.top - br.height - 10;
    let below = false;
    if (top < 10) {
      top = rect.bottom + 10;
      below = true;
    }
    let left = rect.left + rect.width / 2 - br.width / 2;
    const maxLeft = window.innerWidth - br.width - 10;
    if (left < 10) left = 10;
    if (left > maxLeft) left = maxLeft;
    const maxTop = window.innerHeight - br.height - 10;
    if (top > maxTop) top = maxTop;
    if (top < 10) top = 10;
    bubbleEl.style.left = left + 'px';
    bubbleEl.style.top = top + 'px';
    const arrow = document.getElementById('dt-bubble-arrow');
    const arrowColor = rgbaStr(bubbleBg, bubbleOpacity);
    if (below) {
      arrow.style.top = '-8px';
      arrow.style.bottom = 'auto';
      arrow.style.borderBottom = '8px solid ' + arrowColor;
      arrow.style.borderTop = 'none';
    } else {
      arrow.style.bottom = '-8px';
      arrow.style.top = 'auto';
      arrow.style.borderTop = '8px solid ' + arrowColor;
      arrow.style.borderBottom = 'none';
    }
    arrow.style.left = Math.max(14, Math.min(br.width - 14, rect.left + rect.width / 2 - left)) + 'px';
  }

  function showBubble(targetEl, text, state) {
    // state: 'loading' 加载中 | 'ok' 正常 | 'error' 出错
    // （兼容旧写法：true = loading，false = ok）
    ensureBubble();
    bubbleTargetEl = targetEl;
    const txt = document.getElementById('dt-bubble-text');
    txt.textContent = text;
    applyBubbleTextStyle(state);
    if (bubbleHideTimer) { clearTimeout(bubbleHideTimer); bubbleHideTimer = null; }
    // 必须先 display:block 再测量，否则拿到的高度是 0，气泡会定位偏低
    bubbleEl.style.display = 'block';
    bubbleEl.style.opacity = '0';
    positionBubble(targetEl);
    void bubbleEl.offsetHeight;
    bubbleEl.style.opacity = '1';
  }

  function hideBubble() {
    if (!bubbleEl) return;
    bubbleEl.style.opacity = '0';
    if (bubbleHideTimer) clearTimeout(bubbleHideTimer);
    bubbleHideTimer = setTimeout(function () {
      if (bubbleEl) bubbleEl.style.display = 'none';
    }, 150);
    bubbleTargetEl = null;
  }

  // 气泡跟随滚动
  document.addEventListener('scroll', function () {
    if (bubbleTargetEl && bubbleEl && bubbleEl.style.display === 'block') {
      positionBubble(bubbleTargetEl);
    }
  }, { passive: true, capture: true });
  window.addEventListener('resize', function () {
    if (bubbleTargetEl && bubbleEl && bubbleEl.style.display === 'block') {
      positionBubble(bubbleTargetEl);
    }
    onViewportResize();          // 悬浮球：窗口缩放后夹回可视区
  }, { passive: true });

  // ==================== 消息识别 ====================

  // 嵌入卡片 / 组件卡片里的文本块（Discord 新版 Components V2 + 旧版 embed 都覆盖）
  const CARD_TEXT_SEL = [
    '[class*="markdownContainer"]',      // 新版 Components V2 的文本块
    '[class*="embedDescription"]',       // 旧版 embed 描述
    '[class*="embedTitle"]',             // 旧版 embed 标题
    '[class*="embedFieldValue"]',
    '[class*="embedFieldName"]',
    '[class*="embedAuthorName"]',
    '[class*="embedFooterText"]'
  ].join(',');

  // 整块卡片容器
  const CARD_BOX_SEL = [
    '[class*="embedFull"]',
    '[class*="embedWrapper"]',
    '[class*="isComponentsV2"]',
    '[class*="withAccentColor"]'
  ].join(',');

  function hasText(el) {
    return !!(el && el.textContent && el.textContent.trim().length > 1);
  }

  function findMessageEl(target) {
    if (!target || target.nodeType !== 1) return null;
    const closest = function (sel) {
      return target.closest ? target.closest(sel) : null;
    };

    // 1. 普通消息文本（最高优先级，保持原有行为）
    let el = closest('[id^="message-content-"]');
    if (el) return el;

    // 2. 卡片里的具体文本块 —— 精确翻译"鼠标所指的那一段"
    el = closest(CARD_TEXT_SEL);
    if (hasText(el)) return el;

    // 3. 整块卡片（悬停在卡片留白/按钮上时）
    el = closest(CARD_BOX_SEL);
    if (hasText(el)) return el;

    // 4. 附件/卡片总容器兜底
    el = closest('[id^="message-accessories-"]');
    if (hasText(el)) return el;

    // 5. 回复引用 / 转发预览
    el = closest('[class*="repliedMessage"], [class*="forwardedMessage"], [class*="messageReference"]');
    if (hasText(el)) return el;

    // 6. 旧版类名兜底
    el = closest('[class*="messageContent"]');
    if (hasText(el)) return el;

    // 7. 整条消息兜底
    const li = closest('li[id^="chat-messages-"], [data-list-item-id]');
    if (li) {
      const c = li.querySelector('[id^="message-content-"], [class*="messageContent"]');
      if (hasText(c)) return c;
    }
    return null;
  }

  // ==================== 自动聊天翻译（v2.5）====================
  //
  // 需求：
  //   · 聊天区来了新消息就自动翻译，气泡贴在消息上方、跟着滚动一起走
  //   · 最多同时保留 6 条；第 7 条进来时，最旧的那条淡出
  //   · 谁发的都翻（不判断"是不是自己发的" —— 那要读 Discord 内部结构，太脆，不值当）
  //   · 已经有自动气泡的消息，鼠标移上去不再弹悬浮气泡
  //   · 翻译请求串行排队，避免频道一活跃就瞬间打出十几个请求
  //
  // 两个关键设计：
  //   1. **自动气泡和悬浮气泡是两套独立实例**。悬浮那套（bubbleEl 单例）一行都不动，
  //      免得互相踩；自动这套用 Map<消息元素, 气泡元素> 管，天然支持多条并存。
  //   2. **用 snowflake ID 判断"是不是新消息"**。Discord 的消息 ID 随时间递增，
  //      比已知最大 ID 还大 = 真来了新消息；否则是向上滚动加载出来的历史消息，忽略。
  //
  // v2.5 实测后的调整（用户反馈）：
  //   · 只翻**当前屏幕里看得见**的消息 —— 屏幕外的翻了也没人看，
  //     气泡还会被夹到视口边缘，一堆挤在顶部/底部（见 isOnScreen）
  //   · 滚动时消息滚出视口 → 气泡**立刻撤掉，不做淡出**（否则会堆在窗口顶上）
  //   · 气泡水平居中对齐到**文字本身**，不是整行容器 ——
  //     消息容器是块级占满整行，短句子的气泡会飘到右边的空白处（见 textRectOf）
  //   · 气泡**最多停留 15 秒**，过期自动淡出（看过了就别一直杵在句子上方）
  //   · 刚打开频道时 Discord 还在滚到底部，延迟一点再首次扫描
  //   · 带"回复引用"的消息**只翻正文，不翻引用预览**（见 autoTextElOf）

  const AUTO_MAX = 6;              // 同时保留的自动气泡条数
  const AUTO_FADE_MS = 400;        // 淡出时长（渐变消失）
  const AUTO_GAP_MS = 150;         // 两条翻译请求之间的最小间隔
  const AUTO_TTL_MS = 15000;       // 单条气泡最长停留时间，到期淡出
  const AUTO_ONSCREEN_MIN = 12;    // 消息至少露出这么多像素才算"看得见"
  const AUTO_SCAN_DELAY = 500;     // 打开频道后等这么久再首次扫描（等 Discord 滚到底）

  const autoBubbles = new Map();   // 消息元素 -> 气泡元素（Map 保持插入顺序，方便淘汰最旧）
  const autoTimers = new Map();    // 消息元素 -> 过期定时器
  const autoSeen = new WeakSet();  // 已处理过的消息正文元素，避免重复入队
  const autoQueue = [];            // 待翻译队列（放"消息正文元素"）
  let autoPumping = false;         // 队列泵是否在跑
  let autoObserver = null;         // MutationObserver
  let autoMaxId = '';              // 见过的最大消息 ID（只统计"屏幕里看得见"的）
  let autoChannel = '';            // 当前频道路径，用来发现"切频道了"
  let autoRetryTimer = null;       // 聊天区还没渲染出来时的重试定时器
  let autoChanTimer = null;        // 频道切换轮询
  let autoScanTimer = null;        // 首次扫描的延迟定时器
  let autoScrollTimer = null;      // 滚动停止后重扫的防抖定时器
  let autoRafPending = false;      // 滚动重定位的 rAF 节流
  let autoErrorToastShown = false; // 失败提示只弹一次，免得刷屏

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  // 消息是不是"当前屏幕里看得见"。
  // 用可见高度（而不是简单的 rect 相交）判断 —— 只在顶上露出 1~2 像素的消息
  // 也算"已经滚过去了"，气泡留着只会被夹在窗口边缘。
  function isOnScreen(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.height <= 0) return false;
    const visible = Math.min(r.bottom, viewportH()) - Math.max(r.top, 0);
    return visible >= AUTO_ONSCREEN_MIN;
  }

  // 取元素里"文字真正占的位置"。
  // 为什么要单独算：Discord 的消息正文容器是块级元素、宽度占满整行，
  // 直接拿容器的 rect 居中，短句子的气泡就会跑到右边一大片空白上，
  // 让人看不出它翻译的是哪一句。用 Range 框住内容拿到的才是文字的实际范围。
  function textRectOf(el) {
    try {
      const range = document.createRange();
      range.selectNodeContents(el);
      const r = range.getBoundingClientRect();
      if (r && r.width > 1 && r.height > 1) return r;
    } catch (e) { /* 取不到就退回容器 rect */ }
    return el.getBoundingClientRect();
  }

  // Discord 的消息列表容器（多选择器兜底，Discord 改版时不至于整个功能哑掉）
  function findChatList() {
    return document.querySelector('ol[data-list-id="chat-messages"]') ||
           document.querySelector('[class*="messagesWrapper"] [role="list"]') ||
           null;
  }

  // snowflake ID 比较：先比长度，等长再比字典序
  function cmpId(a, b) {
    if (!a) return b ? -1 : 0;
    if (!b) return 1;
    if (a.length !== b.length) return a.length < b.length ? -1 : 1;
    return a < b ? -1 : (a > b ? 1 : 0);
  }

  // 从消息 <li id="chat-messages-<频道>-<消息>"> 里取出消息 ID
  function msgIdOf(li) {
    const id = (li && li.id) || '';
    const m = /^chat-messages-\d+-(\d+)$/.exec(id);
    return m ? m[1] : '';
  }

  // 引用预览的容器选择器。
  // ⚠️ **只排除"引用预览"，不要排除 forwardedMessage（转发）** ——
  // 转发消息的正文就在转发容器里，一起排除就变成"转发消息什么都不翻"。
  const QUOTE_PREVIEW_SEL = '[class*="repliedMessage"], [class*="messageReference"]';

  // 一条消息里真正要翻译的正文（不要用户名、时间戳，也不要在引用预览里）
  //
  // ⚠️ 为什么不能简单写 `li.querySelector('[id^="message-content-"]')`：
  //   Discord 把"回复引用"渲染在正文**之前**，而且引用预览的文本元素
  //   复用了 `message-content-<被引用消息ID>` 这个 id。querySelector 返回的是
  //   文档顺序里的第一个匹配 → 取到的是**引用预览**，正文反而被跳过。
  //   表现就是"同一句话被翻两遍"：原消息翻一次，回复它的那条又把引用翻一次。
  //
  // 三层降级：
  //   ① 用**本条消息自己的 id** 精确取正文 —— 引用预览用的是"被引用的 id"，撞不上
  //   ② 取第一个"不在引用预览容器里"的 message-content
  //   ③ 旧版类名兜底（同样排除引用预览）
  //
  // 悬停翻译走的是另一条路（findMessageEl，鼠标指哪翻哪），**故意不动** ——
  // 用户指着引用想让它翻是合理的；这里只管自动翻译。
  function autoTextElOf(li) {
    if (!li) return null;
    const id = msgIdOf(li);
    if (id) {
      const own = li.querySelector('[id="message-content-' + id + '"]');
      if (hasText(own)) return own;
    }
    const cands = li.querySelectorAll('[id^="message-content-"]');
    for (let i = 0; i < cands.length; i++) {
      if (cands[i].closest(QUOTE_PREVIEW_SEL)) continue;   // 引用预览，跳过
      if (hasText(cands[i])) return cands[i];
    }
    const c = li.querySelector('[class*="messageContent"]');
    if (hasText(c) && !c.closest(QUOTE_PREVIEW_SEL)) return c;
    return null;
  }

  // ---- 气泡：建 / 摆 / 显示 / 淡出 ----

  // 和悬浮气泡共用同一套基础样式（只差 z-index：自动的更低一层，免得盖住悬浮的）
  function bubbleBaseCss(zIndex) {
    return [
      'position:fixed',
      'z-index:' + zIndex,
      'display:none',
      'max-width:400px',
      'min-width:80px',
      'border-radius:8px',
      'padding:10px 14px',
      'opacity:0',
      'transition:opacity .15s ease-in-out',
      'font-family:"Microsoft YaHei","PingFang SC",system-ui,sans-serif',
      'font-size:14px',
      'line-height:1.5',
      'color:#fff',
      'word-wrap:break-word',
      'overflow-wrap:break-word',
      'pointer-events:none',
      '-webkit-font-smoothing:antialiased'
    ].join(';');
  }

  function styleAutoBubble(b) {
    const light = isLightColor(bubbleBg);
    b.style.background = rgbaStr(bubbleBg, bubbleOpacity);
    b.style.border = '1px solid ' + (light ? 'rgba(0,0,0,.10)' : 'rgba(255,255,255,.10)');
    b.style.boxShadow = light ? '0 6px 18px rgba(0,0,0,.22)' : '0 4px 12px rgba(0,0,0,.45)';
    const txt = b.querySelector('.dt-auto-text');
    if (txt) txt.style.color = light ? '#111214' : '#FFFFFF';
  }

  function ensureAutoBubble(targetEl) {
    let b = autoBubbles.get(targetEl);
    if (b) return b;
    b = document.createElement('div');
    b.className = 'dt-auto-bubble';
    b.style.cssText = bubbleBaseCss(2147483644);
    const arrow = document.createElement('div');
    arrow.className = 'dt-auto-arrow';
    arrow.style.cssText = 'position:absolute;width:0;height:0;border-left:8px solid transparent;border-right:8px solid transparent;';
    b.appendChild(arrow);
    const txt = document.createElement('div');
    txt.className = 'dt-auto-text';
    b.appendChild(txt);
    document.body.appendChild(b);
    autoBubbles.set(targetEl, b);
    styleAutoBubble(b);
    return b;
  }

  function restyleAutoBubbles() {
    autoBubbles.forEach(function (b) { styleAutoBubble(b); });
  }

  function positionAutoBubble(b, targetEl) {
    const elRect = targetEl.getBoundingClientRect();
    const tRect = textRectOf(targetEl);   // 文字实际范围（水平居中要用它）
    const br = b.getBoundingClientRect();
    // 垂直：贴在消息容器正上方（用容器 rect，保证"贴在这条消息上"）
    let top = elRect.top - br.height - 10;
    let below = false;
    if (top < 10) { top = elRect.bottom + 10; below = true; }
    // 水平：以**文字**的中心为中心。用容器 rect 的话，短句子的气泡会飘到右边的空白处。
    const cx = tRect.left + tRect.width / 2;
    let left = cx - br.width / 2;
    const maxLeft = viewportW() - br.width - 10;
    if (left < 10) left = 10;
    if (left > maxLeft) left = maxLeft;
    const maxTop = viewportH() - br.height - 10;
    if (top > maxTop) top = maxTop;
    if (top < 10) top = 10;
    b.style.left = left + 'px';
    b.style.top = top + 'px';
    const arrow = b.querySelector('.dt-auto-arrow');
    if (arrow) {
      const ac = rgbaStr(bubbleBg, bubbleOpacity);
      if (below) {
        arrow.style.top = '-8px'; arrow.style.bottom = 'auto';
        arrow.style.borderBottom = '8px solid ' + ac; arrow.style.borderTop = 'none';
      } else {
        arrow.style.bottom = '-8px'; arrow.style.top = 'auto';
        arrow.style.borderTop = '8px solid ' + ac; arrow.style.borderBottom = 'none';
      }
      arrow.style.left = Math.max(14, Math.min(br.width - 14, cx - left)) + 'px';
    }
  }

  function showAutoBubble(targetEl, text) {
    const b = ensureAutoBubble(targetEl);
    const txt = b.querySelector('.dt-auto-text');
    if (txt) txt.textContent = text;
    styleAutoBubble(b);
    b.style.transition = 'opacity .25s ease-out';
    b.style.display = 'block';
    b.style.opacity = '0';
    positionAutoBubble(b, targetEl);
    void b.offsetHeight;   // 先让它参与布局再淡入，否则测到的高度是 0、位置会偏
    b.style.opacity = '1';

    // 最多停留 15 秒（可在 dt_config.json 里用 autoTtl 改），
    // 到期自动淡出 —— 不然看过了也会一直杵在句子上方
    const old = autoTimers.get(targetEl);
    if (old) clearTimeout(old);
    autoTimers.set(targetEl, setTimeout(function () {
      autoTimers.delete(targetEl);
      hideAutoBubble(targetEl);   // 走淡出
    }, autoTtlMs));
  }

  function hideAutoBubble(targetEl, immediate) {
    const b = autoBubbles.get(targetEl);
    if (!b) return;
    const t = autoTimers.get(targetEl);
    if (t) { clearTimeout(t); autoTimers.delete(targetEl); }
    autoBubbles.delete(targetEl);
    if (immediate) {
      if (b.parentNode) b.parentNode.removeChild(b);
      return;
    }
    b.style.transition = 'opacity ' + AUTO_FADE_MS + 'ms ease-out';
    b.style.opacity = '0';
    setTimeout(function () {
      if (b.parentNode) b.parentNode.removeChild(b);
    }, AUTO_FADE_MS + 60);
  }

  // 超过 6 条就把最旧的淡出（Map 的迭代顺序就是插入顺序）
  function autoEvict() {
    while (autoBubbles.size > AUTO_MAX) {
      hideAutoBubble(autoBubbles.keys().next().value);
    }
  }

  // ---- 翻译：串行队列 ----

  // 和 translateAndShow 共用缓存 / 去重，但不管鼠标状态 —— 自动翻译是后台行为
  function translateOnce(text) {
    const key = CONFIG.targetLang + '\u0000' + text;
    const cached = getCached(text);
    if (cached) return Promise.resolve(cached);
    if (inFlight.has(key)) return inFlight.get(key);
    const p = doTranslate(text).then(function (r) {
      setCache(text, r);
      return r;
    }).finally(function () {
      inFlight.delete(key);
    });
    inFlight.set(key, p);
    return p;
  }

  function autoEnqueue(el) {
    if (!el || !autoTranslateOn || !translationEnabled) return;
    if (autoSeen.has(el)) return;
    // 只翻当前屏幕里看得见的 —— 屏幕外的翻了也没人看，
    // 气泡还会被夹到视口边缘、一堆挤在顶部/底部（用户实测反馈）。
    // 这里不标记 autoSeen：等用户滚到它、它进了视口，还能再翻。
    if (!isOnScreen(el)) return;
    const text = (el.textContent || '').trim();
    if (!hasLetters(text)) return;
    if (isAlreadyTarget(text)) return;   // 本来就是目标语言，不发请求
    autoSeen.add(el);
    autoQueue.push(el);
    autoPump();
  }

  async function autoPump() {
    if (autoPumping) return;
    autoPumping = true;
    while (autoQueue.length) {
      const el = autoQueue.shift();
      if (!el || !el.isConnected) continue;      // 消息已经被滚掉了
      if (autoBubbles.has(el)) continue;         // 已经有气泡了
      const text = (el.textContent || '').trim();
      if (!text || !hasLetters(text)) continue;
      try {
        let tr = getCached(text);
        if (!tr) tr = await translateOnce(text);
        if (!el.isConnected) continue;
        if (normalize(tr) === normalize(text)) continue;   // 原文本来就是目标语言
        showAutoBubble(el, tr);
        autoEvict();
      } catch (err) {
        // 自动翻译是后台行为，失败不往每条消息上挂红字（会刷屏），
        // 只弹一次提示 + 控制台留痕
        if (!autoErrorToastShown) {
          autoErrorToastShown = true;
          toast((err && err.message) || t('errGeneric'), false, 5000);
        }
        try { console.warn('[DT] 自动翻译失败：', (err && err.message) || err); } catch (e) {}
      }
      await sleep(AUTO_GAP_MS);
    }
    autoPumping = false;
  }

  // ---- 新消息检测 ----

  // 把列表里"比 autoMaxId 新、而且当前屏幕里看得见"的消息挑出来
  function collectFreshVisible(list) {
    const items = list.querySelectorAll('li[id^="chat-messages-"]');
    const fresh = [];
    for (let i = 0; i < items.length; i++) {
      const id = msgIdOf(items[i]);
      if (!id) continue;
      if (cmpId(id, autoMaxId) <= 0) continue;   // 不比已知的最新更"新"
      if (!isOnScreen(items[i])) continue;       // 屏幕外的先不翻
      fresh.push(items[i]);
    }
    return fresh;
  }

  // 刚进频道 / 刚打开自动翻译时，把**已经在屏幕上**的最新 6 条补翻一遍。
  // 注意：只认屏幕里看得见的 —— 刚打开频道时 Discord 还在往下滚，
  // 屏幕外那几十条要是也翻了，气泡会被夹到视口边缘、全挤在最底下（用户实测反馈）。
  function autoScanExisting() {
    const list = findChatList();
    if (!list) return;
    const items = list.querySelectorAll('li[id^="chat-messages-"]');
    // autoMaxId 只按"看得见的"推进 —— 屏幕外那些留着，
    // 等用户滚到那儿再由 autoScanVisible 补翻
    Array.prototype.forEach.call(items, function (li) {
      if (!isOnScreen(li)) return;
      const id = msgIdOf(li);
      if (cmpId(id, autoMaxId) > 0) autoMaxId = id;
    });
    // 从下往上数 6 条"看得见的"
    const recent = [];
    for (let i = items.length - 1; i >= 0 && recent.length < AUTO_MAX; i--) {
      if (!isOnScreen(items[i])) continue;
      recent.push(items[i]);
    }
    recent.reverse().forEach(function (li) {
      const el = autoTextElOf(li);
      if (el) autoEnqueue(el);
    });
  }

  // 滚动停下后跑：把"刚滚进视口的新消息"补翻上。
  // 覆盖的场景：打开频道时列表还没滚到底，那会儿它们还在屏幕外；
  // 用户滚到底之后，这几条才算"看得见"，这时候才翻。
  function autoScanVisible() {
    if (!autoTranslateOn || !translationEnabled) return;
    const list = findChatList();
    if (!list) return;
    const fresh = collectFreshVisible(list);
    if (!fresh.length) return;
    for (let i = 0; i < fresh.length; i++) {
      const id = msgIdOf(fresh[i]);
      if (cmpId(id, autoMaxId) > 0) autoMaxId = id;
    }
    // 一次最多翻 6 条，免得滚一下冒出一大片
    fresh.slice(-AUTO_MAX).forEach(function (li) {
      const el = autoTextElOf(li);
      if (el) autoEnqueue(el);
    });
  }

  function onAutoMutations(muts) {
    if (!autoTranslateOn || !translationEnabled) return;
    for (let i = 0; i < muts.length; i++) {
      const added = muts[i].addedNodes;
      for (let j = 0; j < added.length; j++) {
        const n = added[j];
        if (!n || n.nodeType !== 1) continue;
        const lis = [];
        if (n.matches && n.matches('li[id^="chat-messages-"]')) lis.push(n);
        if (n.querySelectorAll) {
          Array.prototype.forEach.call(
            n.querySelectorAll('li[id^="chat-messages-"]'),
            function (x) { lis.push(x); }
          );
        }
        for (let k = 0; k < lis.length; k++) {
          const li = lis[k];
          const id = msgIdOf(li);
          if (!id) continue;
          // ID 比已知最大 ID 还大 = 真·新消息；否则是向上滚动加载出来的历史消息
          if (cmpId(id, autoMaxId) <= 0) continue;
          // 屏幕外的先不翻、也不推进 autoMaxId —— 等用户滚到那儿再翻
          if (!isOnScreen(li)) continue;
          autoMaxId = id;
          const el = autoTextElOf(li);
          if (el) autoEnqueue(el);
        }
      }
    }
  }

  function startAuto() {
    if (autoObserver) return;
    const list = findChatList();
    if (!list) {
      // 聊天区还没渲染出来（比如刚启动 Discord），过一秒再试
      if (!autoRetryTimer) {
        autoRetryTimer = setTimeout(function () {
          autoRetryTimer = null;
          if (autoTranslateOn && translationEnabled) startAuto();
        }, 1000);
      }
      return;
    }
    autoChannel = location.pathname;
    // 先挂观察者再延迟扫描 —— 否则这 500ms 里进来的新消息会被漏掉
    autoObserver = new MutationObserver(onAutoMutations);
    autoObserver.observe(list, { childList: true, subtree: false });
    // 延迟一点再首次扫描：刚打开频道时 Discord 还在往下滚，
    // 立刻扫会扫到"屏幕外的一堆消息"，气泡全被夹到最底下（用户实测反馈）
    if (autoScanTimer) clearTimeout(autoScanTimer);
    autoScanTimer = setTimeout(function () {
      autoScanTimer = null;
      if (!autoTranslateOn || !translationEnabled) return;
      autoScanExisting();
    }, AUTO_SCAN_DELAY);
  }

  function stopAuto() {
    if (autoObserver) { autoObserver.disconnect(); autoObserver = null; }
    if (autoRetryTimer) { clearTimeout(autoRetryTimer); autoRetryTimer = null; }
    if (autoScanTimer) { clearTimeout(autoScanTimer); autoScanTimer = null; }
    if (autoScrollTimer) { clearTimeout(autoScrollTimer); autoScrollTimer = null; }
    autoQueue.length = 0;
    // 关功能时直接移除、不做淡出 —— 否则气泡在屏幕上慢慢消失，看着像卡住了
    Array.from(autoBubbles.keys()).forEach(function (k) { hideAutoBubble(k, true); });
    autoBubbles.clear();
    autoTimers.forEach(function (t) { clearTimeout(t); });
    autoTimers.clear();
    autoMaxId = '';
  }

  // 配置或总开关变化时调用：决定自动翻译该开还是该停
  function syncAutoTranslate() {
    if (autoTranslateOn && translationEnabled) {
      startAuto();
      watchAutoChannel();
    } else {
      stopAuto();
    }
    restyleAutoBubbles();
  }

  // Discord 是单页应用，切频道不会刷新页面 —— 轮询路径变化来发现它
  function watchAutoChannel() {
    if (autoChanTimer) return;
    autoChanTimer = setInterval(function () {
      if (!autoTranslateOn || !translationEnabled) return;
      if (location.pathname === autoChannel) return;
      autoChannel = location.pathname;
      // 换频道了：旧气泡全清，重新扫描新频道的最新 6 条
      if (autoObserver) { autoObserver.disconnect(); autoObserver = null; }
      if (autoScanTimer) { clearTimeout(autoScanTimer); autoScanTimer = null; }
      Array.from(autoBubbles.keys()).forEach(function (k) { hideAutoBubble(k, true); });
      autoBubbles.clear();
      autoTimers.forEach(function (t) { clearTimeout(t); });
      autoTimers.clear();
      autoMaxId = '';
      startAuto();
    }, 1200);
  }

  // 用户开关自动翻译（右键菜单 / 设置面板都走这里）
  function setAutoTranslate(on, notify) {
    on = !!on;
    if (on && !CONFIG.apiKey) {
      toast(t('errNoKey'), false, 5000);
      return;
    }
    autoTranslateOn = on;
    saveConfigQuiet({ autoTranslate: on ? '1' : '0' });
    if (on) {
      autoErrorToastShown = false;
      startAuto();
      watchAutoChannel();
    } else {
      stopAuto();
    }
    if (notify) toast(on ? t('toastAutoOn') : t('toastAutoOff'), true);
    // 新手引导期间用户自己把开关打开了 → 引导任务完成，收摊
    if (guideStep) guideFinish();
  }

  // ---- 滚动时跟着走 ----
  // 自动气泡可能有好几个，一起重算位置；用 rAF 节流，免得滚动时每帧算好几遍
  function repositionAutoBubbles() {
    if (!autoBubbles.size) return;
    Array.from(autoBubbles.keys()).forEach(function (targetEl) {
      const b = autoBubbles.get(targetEl);
      if (!b) return;
      // 消息被回收 / 滚出视口 → 立刻撤掉气泡，**不做淡出**。
      // 做淡出的话，滚动过程中气泡会一边慢慢消失一边被夹到窗口顶上，
      // 看着像一堆气泡堆在顶部（用户实测反馈）。
      if (!targetEl.isConnected || !isOnScreen(targetEl)) {
        hideAutoBubble(targetEl, true);
        return;
      }
      positionAutoBubble(b, targetEl);
    });
  }

  document.addEventListener('scroll', function () {
    if (!autoTranslateOn || !translationEnabled) return;
    // 立刻：把滚出视口的气泡撤掉 + 重定位（rAF 节流，别每帧都算）
    if (!autoRafPending) {
      autoRafPending = true;
      requestAnimationFrame(function () {
        autoRafPending = false;
        repositionAutoBubbles();
      });
    }
    // 滚动停下 250ms 后再扫一遍"刚滚进视口的新消息"。
    // 不能每帧都扫 —— 那要遍历整个消息列表，长频道里会卡。
    if (autoScrollTimer) clearTimeout(autoScrollTimer);
    autoScrollTimer = setTimeout(function () {
      autoScrollTimer = null;
      autoScanVisible();
    }, 250);
  }, { passive: true, capture: true });

  // ==================== 鼠标事件 ====================

  document.addEventListener('mouseover', function (e) {
    if (!translationEnabled) return;
    if (e.target.closest && e.target.closest('#dt-ball, #dt-settings, #dt-menu, #dt-settings-overlay')) return;

    const msgEl = findMessageEl(e.target);
    if (!msgEl) return;
    // v2.5：这条消息已经有自动翻译气泡了 → 不再弹悬浮气泡。
    // 两套气泡贴的是同一个位置，一起出来会叠成两层字，糊成一片。
    if (autoBubbles.has(msgEl)) return;
    const text = (msgEl.textContent || '').trim();
    if (!hasLetters(text)) return;
    // 已经是目标语言 → 不翻译（这一步在本地完成，不产生任何网络请求）
    if (isAlreadyTarget(text)) return;

    if (currentHoverEl === msgEl) {
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
      return;
    }
    currentHoverEl = msgEl;
    if (debounceTimer) clearTimeout(debounceTimer);
    if (hideTimer) clearTimeout(hideTimer);

    debounceTimer = setTimeout(function () {
      if (currentHoverEl === msgEl) translateAndShow(msgEl, text);
    }, debounceDelay);
  }, true);

  document.addEventListener('mouseout', function (e) {
    const msgEl = findMessageEl(e.target);
    if (!msgEl || msgEl !== currentHoverEl) return;
    if (e.relatedTarget) {
      const rel = findMessageEl(e.relatedTarget);
      if (rel === msgEl) return;
    }
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    hideTimer = setTimeout(function () {
      hideBubble();
      currentHoverEl = null;
    }, 100);
  }, true);

  async function translateAndShow(msgEl, text) {
    let translation = getCached(text);
    if (translation) {
      if (normalize(translation) === normalize(text)) return;   // 原文就是目标语言
      showBubble(msgEl, translation, 'ok');
      return;
    }
    if (inFlight.has(CONFIG.targetLang + '\u0000' + text)) {
      try {
        translation = await inFlight.get(CONFIG.targetLang + '\u0000' + text);
        if (currentHoverEl === msgEl && normalize(translation) !== normalize(text)) {
          showBubble(msgEl, translation, 'ok');
        }
      } catch (e) {}
      return;
    }

    // 350ms 内没结果才显示"正在翻译…"，命中缓存或极快返回时不闪
    if (loadingTimer) clearTimeout(loadingTimer);
    loadingTimer = setTimeout(function () {
      if (currentHoverEl === msgEl) showBubble(msgEl, t('translating'), 'loading');
    }, 350);

    const key = CONFIG.targetLang + '\u0000' + text;
    const p = doTranslate(text).then(function (r) {
      setCache(text, r);
      return r;
    }).finally(function () {
      inFlight.delete(key);
    });
    inFlight.set(key, p);
    try {
      translation = await p;
      if (loadingTimer) { clearTimeout(loadingTimer); loadingTimer = null; }
      if (currentHoverEl !== msgEl) return;
      // 模型判断"原文已是目标语言"时会原样返回 —— 这种情况不显示气泡
      if (normalize(translation) === normalize(text)) { hideBubble(); return; }
      showBubble(msgEl, translation, 'ok');
    } catch (err) {
      if (loadingTimer) { clearTimeout(loadingTimer); loadingTimer = null; }
      if (currentHoverEl === msgEl) {
        // 错误用高亮红字显示，并给足阅读时间（不是"加载中"那种灰斜体）
        showBubble(msgEl, err.message || t('errGeneric'), 'error');
        setTimeout(function () { if (currentHoverEl === msgEl) hideBubble(); }, 6000);
      }
    }
  }

  // ==================== 悬浮球 ====================

  let ballEl = null;
  let menuEl = null;
  let dragging = false;
  let moved = false;
  let dsx = 0, dsy = 0, bsl = 0, bst = 0;
  let collapsed = false;
  let autoHideTimer = null;

  // ms 可选：默认 1800ms；报错类文案可以传长一点，免得没看清就消失了
  function toast(msg, ok, ms) {
    const tt = document.createElement('div');
    tt.style.cssText = 'position:fixed;z-index:2147483647;top:24px;left:50%;transform:translateX(-50%);background:' + (ok ? 'rgba(67,181,129,.95)' : 'rgba(240,71,71,.95)') + ';color:#fff;padding:9px 22px;border-radius:22px;font-size:14px;font-family:"Microsoft YaHei",system-ui,sans-serif;opacity:0;transition:opacity .3s;pointer-events:none;box-shadow:0 4px 16px rgba(0,0,0,.4);max-width:70vw;';
    tt.textContent = msg;
    document.body.appendChild(tt);
    void tt.offsetHeight;
    tt.style.opacity = '1';
    setTimeout(function () {
      tt.style.opacity = '0';
      setTimeout(function () { if (tt.parentNode) tt.parentNode.removeChild(tt); }, 300);
    }, ms || 1800);
  }

  function updateBallState() {
    if (!ballEl) return;
    ballEl.style.border = translationEnabled ? '2px solid #43B581' : '2px solid #F04747';
    ballEl.style.background = translationEnabled
      ? 'linear-gradient(135deg,#5865F2,#4752C4)'
      : 'linear-gradient(135deg,#555,#383838)';
  }

  // ===== 悬浮球定位 =====
  // 位置一律用「距右 / 距下」的偏移量表示，不用 left/top。
  // 原因：left/top 是相对视口左上角的绝对坐标，窗口一缩放就错位 ——
  //       在最大化窗口里把球拖到右下角（left/top 很大），还原窗口后这个坐标
  //       落在可视区外，球就"消失"了。
  // 换成距右/距下偏移后，无论放大还是还原，球都稳定停在下角那一块。
  const BALL_MARGIN = 20;          // 默认边距

  // 视口尺寸一律用 documentElement.clientWidth/Height —— 它**不含滚动条**，
  // 正好等于 position:fixed 的定位基准（initial containing block）。
  // 用 window.innerWidth 会多算一条滚动条的宽度（约 15px），
  // 结果是把球拖到最左边时会有十几像素被推出屏幕外。
  function viewportW() {
    const d = document.documentElement;
    return (d && d.clientWidth) || window.innerWidth;
  }

  function viewportH() {
    const d = document.documentElement;
    return (d && d.clientHeight) || window.innerHeight;
  }

  function ballMaxRight() {
    return Math.max(0, viewportW() - ballEl.offsetWidth);
  }

  function ballMaxBottom() {
    return Math.max(0, viewportH() - ballEl.offsetHeight);
  }

  // 把球夹回可视区内，并统一改写成 right/bottom 定位
  function clampBall() {
    if (!ballEl) return;
    let r = parseFloat(ballEl.style.right);
    let b = parseFloat(ballEl.style.bottom);
    if (isNaN(r)) r = BALL_MARGIN;
    if (isNaN(b)) b = BALL_MARGIN;
    r = Math.max(0, Math.min(ballMaxRight(), r));
    b = Math.max(0, Math.min(ballMaxBottom(), b));
    ballEl.style.left = 'auto';
    ballEl.style.top = 'auto';
    ballEl.style.right = r + 'px';
    ballEl.style.bottom = b + 'px';
    return { right: r, bottom: b };
  }

  // 依据配置摆放悬浮球（含老配置的一次性换算）
  function applyBallPosition() {
    if (!ballEl) return;
    let r = CONFIG.ballRight;
    let b = CONFIG.ballBottom;
    if (r === '' || r === undefined || r === null || isNaN(parseFloat(r)) ||
        b === '' || b === undefined || b === null || isNaN(parseFloat(b))) {
      // 兼容老配置：以前存的是 left/top 绝对坐标，按当前视口换算成距右/距下
      const px = parseFloat(CONFIG.ballX);
      const py = parseFloat(CONFIG.ballY);
      if (!isNaN(px) && !isNaN(py)) {
        r = viewportW() - px - ballEl.offsetWidth;
        b = viewportH() - py - ballEl.offsetHeight;
      } else {
        r = BALL_MARGIN;
        b = BALL_MARGIN;
      }
    }
    ballEl.style.left = 'auto';
    ballEl.style.top = 'auto';
    ballEl.style.right = parseFloat(r) + 'px';
    ballEl.style.bottom = parseFloat(b) + 'px';
    clampBall();
  }

  // 窗口缩放时把球夹回可视区。
  // 因为是 right/bottom 定位，正常情况下缩放后球会自然贴住右下角那块，
  // 只有窗口缩得特别小（边距超出视口）时才需要夹一下。
  function onViewportResize() {
    if (!ballEl || dragging) return;
    clampBall();
  }

  function createBall() {
    if (ballEl) return;
    ballEl = document.createElement('div');
    ballEl.id = 'dt-ball';
    ballEl.title = t('appName');
    ballEl.style.cssText = 'position:fixed;z-index:2147483645;width:40px;height:40px;border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;user-select:none;opacity:.3;transition:opacity .3s,transform .2s,box-shadow .3s,width .2s,height .2s;box-shadow:0 2px 8px rgba(0,0,0,.3);color:#fff;font-size:17px;font-weight:600;font-family:"Microsoft YaHei",system-ui,sans-serif;';
    ballEl.textContent = '译';
    document.body.appendChild(ballEl);
    applyBallPosition();
    updateBallState();

    ballEl.addEventListener('mouseenter', function () {
      ballEl.style.opacity = '1';
      ballEl.classList.remove('dt-dim');
      resetAutoHide();
    });
    ballEl.addEventListener('mouseleave', function () {
      if (!collapsed) ballEl.style.opacity = '.3';
    });

    // 拖拽 + 点击
    ballEl.addEventListener('mousedown', function (e) {
      if (e.button === 2) return;
      dragging = true;
      moved = false;
      dsx = e.clientX; dsy = e.clientY;
      const r = ballEl.getBoundingClientRect();
      bsl = r.left; bst = r.top;
      ballEl.style.opacity = '1';
      e.preventDefault();
    });

    document.addEventListener('mousemove', function (e) {
      resetAutoHide();
      if (!dragging) return;
      const dx = e.clientX - dsx, dy = e.clientY - dsy;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
      let nl = Math.max(0, Math.min(viewportW() - ballEl.offsetWidth, bsl + dx));
      let nt = Math.max(0, Math.min(viewportH() - ballEl.offsetHeight, bst + dy));
      ballEl.style.left = nl + 'px';
      ballEl.style.top = nt + 'px';
      ballEl.style.right = 'auto';
      ballEl.style.bottom = 'auto';
    });

    document.addEventListener('mouseup', function (e) {
      if (!dragging) return;
      dragging = false;
      if (moved) {
        // 松手时把"跟手用的 left/top"换算成"距右/距下"存起来 ——
        // 这样之后窗口放大还是还原，球都稳定停在右下角那一块，不会跑出可视区。
        const r = ballEl.getBoundingClientRect();
        const right = Math.max(0, Math.round(viewportW() - r.right));
        const bottom = Math.max(0, Math.round(viewportH() - r.bottom));
        ballEl.style.left = 'auto';
        ballEl.style.top = 'auto';
        ballEl.style.right = right + 'px';
        ballEl.style.bottom = bottom + 'px';
        saveConfigQuiet({ ballRight: right, ballBottom: bottom, ballX: '', ballY: '' });
      } else if (e.button === 0) {
        translationEnabled = !translationEnabled;
        saveConfigQuiet({ enabled: translationEnabled ? '1' : '0' });
        updateBallState();
        if (!translationEnabled) hideBubble();
        toast(translationEnabled ? t('toastOn') : t('toastOff'), true);
      }
    });

    ballEl.addEventListener('dblclick', function (e) {
      e.preventDefault();
      toggleCollapse();
    });

    ballEl.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      e.stopPropagation();
      showMenu(e.clientX, e.clientY);
    });

    resetAutoHide();
  }

  function toggleCollapse() {
    collapsed = !collapsed;
    if (collapsed) {
      ballEl.style.width = '12px';
      ballEl.style.height = '12px';
      ballEl.style.opacity = '.25';
      ballEl.textContent = '';
      toast(t('toastCollapsed'), true);
    } else {
      ballEl.style.width = '40px';
      ballEl.style.height = '40px';
      ballEl.style.opacity = '.3';
      ballEl.textContent = '译';
    }
    clampBall();   // 尺寸变了（40px ↔ 12px），重新夹一次确保不越界
  }

  function resetAutoHide() {
    if (autoHideTimer) clearTimeout(autoHideTimer);
    autoHideTimer = setTimeout(function () {
      if (ballEl && !dragging && !collapsed) {
        ballEl.style.opacity = '.15';
      }
    }, 10000);
  }

  // ==================== 右键菜单 ====================

  function showMenu(x, y) {
    if (!menuEl) {
      menuEl = document.createElement('div');
      menuEl.id = 'dt-menu';
      menuEl.style.cssText = 'position:fixed;z-index:2147483647;display:none;background:#2B2D31;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.5);padding:6px 0;min-width:210px;font-family:"Microsoft YaHei",system-ui,sans-serif;font-size:13px;';
      document.body.appendChild(menuEl);
    }
    const online = NATIVE.available();
    const dot = function (on) {
      return '<span style="width:8px;height:8px;border-radius:50%;flex:0 0 auto;background:' + (on ? '#43B581' : '#F04747') + ';"></span>';
    };
    menuEl.innerHTML =
      '<div style="padding:6px 14px 2px;color:#949BA4;font-size:11px;">' + t('appName') + ' ' + window.__DT_VERSION__ + '</div>' +
      '<div style="padding:2px 14px 6px;color:#B5BAC1;font-size:11px;display:flex;align-items:center;gap:6px;">' +
        dot(translationEnabled) + (translationEnabled ? t('statusOn') : t('statusOff')) +
      '</div>' +
      '<div style="padding:0 14px 6px;color:#B5BAC1;font-size:11px;display:flex;align-items:center;gap:6px;">' +
        dot(online) + (online ? t('bridgeOn') : t('bridgeOff')) +
      '</div>' +
      '<div style="padding:0 14px 8px;color:#949BA4;font-size:11px;">→ ' + langName(CONFIG.targetLang) + '</div>' +
      '<div style="height:1px;background:rgba(255,255,255,.08);margin:4px 8px;"></div>' +
      menuItem('toggle', translationEnabled ? t('turnOff') : t('turnOn')) +
      // v2.5：自动聊天翻译开关。带个小圆点，跟上面的状态点一个样式，一眼能看出开没开。
      // 加 id 是为了新手引导能精确定位到它、给它打聚光灯。
      '<div data-act="auto" id="dt-menu-auto" style="padding:8px 14px;color:#DBDEE1;cursor:pointer;display:flex;align-items:center;gap:8px;">' +
        '<span style="width:8px;height:8px;border-radius:50%;flex:0 0 auto;background:' + (autoTranslateOn ? '#43B581' : '#F04747') + ';"></span>' +
        '<span>' + (autoTranslateOn ? t('autoOff') : t('autoOn')) + '</span>' +
      '</div>' +
      menuItem('settings', t('settings')) +
      menuItem('clear', t('clearCache')) +
      '<div style="height:1px;background:rgba(255,255,255,.08);margin:4px 8px;"></div>' +
      menuItem('collapse', collapsed ? t('expand') : t('collapse')) +
      '<div style="height:1px;background:rgba(255,255,255,.08);margin:4px 8px;"></div>' +
      menuItem('quit', t('quit')) +
      '<div data-act="about" style="padding:8px 14px;color:#949BA4;font-size:12px;cursor:pointer;">' + t('about') + '</div>';

    menuEl.querySelectorAll('[data-act]').forEach(function (it) {
      it.addEventListener('mouseenter', function () { this.style.background = 'rgba(88,101,242,.2)'; });
      it.addEventListener('mouseleave', function () { this.style.background = 'transparent'; });
      it.addEventListener('click', function () {
        handleAction(this.getAttribute('data-act'));
        menuEl.style.display = 'none';
      });
    });

    menuEl.style.display = 'block';
    const mr = menuEl.getBoundingClientRect();
    menuEl.style.left = Math.min(x, window.innerWidth - mr.width - 10) + 'px';
    menuEl.style.top = Math.min(y, window.innerHeight - mr.height - 10) + 'px';

    // v2.5 新手引导：用户按引导右键点开悬浮球了 → 小手挪到"自动翻译"这一项上
    if (guideStep === 1) guideToStep2();

    setTimeout(function () {
      document.addEventListener('click', function h() {
        menuEl.style.display = 'none';
        // 引导第 2 步时把菜单关掉了（没点"自动翻译"）→ 退回首步提示，别让人卡住。
        // 但如果他是点了"设置"跳去面板了，就交给 showSettings 那边接管，别抢。
        if (guideStep === 2 && (!panelEl || panelEl.style.display !== 'block')) guideStep1();
        document.removeEventListener('click', h);
      }, { once: true });
    }, 10);
  }

  function menuItem(act, label) {
    return '<div data-act="' + act + '" style="padding:8px 14px;color:#DBDEE1;cursor:pointer;">' + label + '</div>';
  }

  function handleAction(act) {
    if (act === 'toggle') {
      translationEnabled = !translationEnabled;
      saveConfigQuiet({ enabled: translationEnabled ? '1' : '0' });
      updateBallState();
      if (!translationEnabled) hideBubble();
      toast(translationEnabled ? t('toastOn') : t('toastOff'), true);
    } else if (act === 'auto') {
      setAutoTranslate(!autoTranslateOn, true);
    } else if (act === 'settings') {
      showSettings();
    } else if (act === 'clear') {
      cache.clear();
      toast(t('toastCacheCleared'), true);
    } else if (act === 'collapse') {
      toggleCollapse();
    } else if (act === 'quit') {
      if (!NATIVE.available()) {
        toast(t('toastNoBridgeQuit'), false);
        return;
      }
      NATIVE.call('quit', {}, 5000).catch(function () {});
      toast(t('toastQuit'), true);
      setTimeout(function () {
        if (ballEl && ballEl.parentNode) ballEl.parentNode.removeChild(ballEl);
        if (menuEl && menuEl.parentNode) menuEl.parentNode.removeChild(menuEl);
        hideBubble();
      }, 400);
    } else if (act === 'about') {
      toast(t('aboutText'), true);
    }
  }

  // ==================== 设置面板 ====================

  const PRESET_COLORS = [
    '#000000', '#1E1F22', '#2B2D31', '#1A2B4C',
    '#2B1B3D', '#14301F', '#3A1414', '#4A3B12',
    '#FFFFFF', '#F2F3F5', '#FFF4D6', '#E8F0FE'
  ];

  let overlayEl = null;
  let panelEl = null;

  function selectHtml(id, options, current) {
    let h = '<select id="' + id + '" style="width:100%;background:#1E1F22;border:1px solid #0E0F11;border-radius:6px;padding:9px 10px;color:#DBDEE1;font-size:13px;outline:none;cursor:pointer;">';
    options.forEach(function (o) {
      h += '<option value="' + o.value + '"' + (o.value === current ? ' selected' : '') + '>' + o.label + '</option>';
    });
    return h + '</select>';
  }

  function labelHtml(text, mt) {
    return '<div style="font-size:13px;color:#B5BAC1;margin:' + (mt || 14) + 'px 0 7px;">' + text + '</div>';
  }

  // v2.5：Discord 风格的开关滑块（设置面板 / 新手引导都认它）
  function switchHtml(id, on) {
    return '<div id="' + id + '" class="dt-switch" data-on="' + (on ? '1' : '0') + '" ' +
      'style="width:44px;height:24px;border-radius:12px;flex:0 0 auto;cursor:pointer;position:relative;' +
      'background:' + (on ? '#5865F2' : '#4E5058') + ';transition:background .18s;">' +
      '<span style="position:absolute;top:3px;left:' + (on ? '23px' : '3px') + ';width:18px;height:18px;' +
      'border-radius:50%;background:#fff;transition:left .18s;box-shadow:0 1px 3px rgba(0,0,0,.3);"></span>' +
    '</div>';
  }

  // 就地刷新开关外观（不重建整个面板 —— 否则用户还没保存的 API Key / 透明度会被冲掉）
  function updateSwitch(el, on) {
    if (!el) return;
    el.setAttribute('data-on', on ? '1' : '0');
    el.style.background = on ? '#5865F2' : '#4E5058';
    const knob = el.firstChild;
    if (knob) knob.style.left = on ? '23px' : '3px';
  }

  function renderPanel() {
    const uiOptions = [
      { value: 'zh', label: '简体中文' },
      { value: 'en', label: 'English' }
    ];
    const langOptions = LANGUAGES.map(function (l) {
      return { value: l.code, label: l.name };
    });

    const cur = editingBg || bubbleBg;
    let swatches = '';
    PRESET_COLORS.forEach(function (c) {
      const sel = (c.toLowerCase() === cur.toLowerCase());
      swatches += '<span class="dt-sw" data-color="' + c + '" style="display:inline-block;width:26px;height:26px;border-radius:6px;cursor:pointer;background:' + c + ';border:2px solid ' + (sel ? '#5865F2' : 'rgba(255,255,255,.18)') + ';box-sizing:border-box;"></span>';
    });

    panelEl.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;padding:14px 18px;background:#2B2D31;">' +
        '<span style="font-size:15px;font-weight:600;color:#F2F3F5;">' + t('settingsTitle') + '</span>' +
        '<span id="dt-sp-close" title="' + t('close') + '" style="font-size:22px;color:#949BA4;cursor:pointer;line-height:1;">×</span>' +
      '</div>' +
      '<div style="padding:18px;max-height:calc(100vh - 100px);overflow-y:auto;">' +
        '<div id="dt-sp-bridge" style="display:flex;align-items:center;gap:6px;font-size:12px;padding:8px 10px;border-radius:6px;background:#1E1F22;margin-bottom:4px;"></div>' +

        // v2.5 新增：自动聊天翻译开关。放最上面 —— 一来它是这个版本的主打功能，
        // 二来新手引导要指着它，放顶部就不用滚动、不会被面板高度裁掉。
        '<div style="display:flex;align-items:center;gap:12px;padding:12px;border-radius:8px;background:#1E1F22;border:1px solid rgba(88,101,242,.35);margin:8px 0 4px;">' +
          '<div style="flex:1;min-width:0;">' +
            '<div style="font-size:13px;color:#F2F3F5;font-weight:600;display:flex;align-items:center;gap:6px;">' +
              t('secAuto') +
              '<span style="font-size:10px;font-weight:700;color:#fff;background:#5865F2;border-radius:4px;padding:1px 5px;letter-spacing:.5px;">NEW</span>' +
            '</div>' +
            '<div style="font-size:11px;color:#949BA4;margin-top:4px;line-height:1.4;">' +
              t('autoHint').replace('{s}', String(Math.round(autoTtlMs / 1000))) + '</div>' +
          '</div>' +
          switchHtml('dt-sp-auto', autoTranslateOn) +
        '</div>' +

        '<div style="display:flex;gap:12px;">' +
          '<div style="flex:1;min-width:0;">' +
            labelHtml(t('secUiLang'), 14) +
            selectHtml('dt-sp-ui', uiOptions, CONFIG.uiLang) +
          '</div>' +
          '<div style="flex:1.3;min-width:0;">' +
            labelHtml(t('secTarget'), 14) +
            selectHtml('dt-sp-target', langOptions, CONFIG.targetLang) +
          '</div>' +
        '</div>' +
        '<div style="font-size:11px;color:#949BA4;margin-top:6px;">' + t('targetHint') + '</div>' +

        labelHtml(t('secApiKey'), 14) +
        '<div style="display:flex;gap:8px;">' +
          '<input id="dt-sp-key" type="password" placeholder="sk-xxxxxxxx" style="flex:1;background:#1E1F22;border:1px solid #0E0F11;border-radius:6px;padding:9px 12px;color:#DBDEE1;font-size:13px;outline:none;">' +
          '<button id="dt-sp-test" style="background:#4E5058;color:#fff;border:none;border-radius:6px;padding:9px 12px;font-size:13px;cursor:pointer;white-space:nowrap;">' + t('test') + '</button>' +
        '</div>' +
        '<div style="font-size:11px;color:#949BA4;margin-top:6px;">' + t('keyHelp') + '</div>' +

        labelHtml(t("secColor"), 14) +
        '<div id="dt-sp-swatches" style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;">' + swatches +
          '<input id="dt-sp-bg" type="color" value="' + cur + '" title="' + t('customColor') + '" style="width:34px;height:26px;padding:0;border:1px solid rgba(255,255,255,.18);border-radius:6px;background:#1E1F22;cursor:pointer;">' +
        '</div>' +

        labelHtml(t("secOpacity"), 14) +
        '<div style="display:flex;align-items:center;gap:10px;">' +
          '<input id="dt-sp-opa" type="range" min="10" max="100" step="5" style="flex:1;accent-color:#5865F2;">' +
          '<span id="dt-sp-ov" style="color:#5865F2;font-weight:600;font-size:13px;width:46px;text-align:right;"></span>' +
        '</div>' +

        labelHtml(t("secDelay"), 14) +
        '<div style="display:flex;align-items:center;gap:10px;">' +
          '<input id="dt-sp-deb" type="range" min="100" max="1000" step="100" style="flex:1;accent-color:#5865F2;">' +
          '<span id="dt-sp-dv" style="color:#5865F2;font-weight:600;font-size:13px;width:46px;text-align:right;"></span>' +
        '</div>' +

        labelHtml(t("preview"), 14) +
        '<div id="dt-sp-preview" style="padding:8px 12px;border-radius:8px;font-size:14px;line-height:1.5;color:#fff;word-wrap:break-word;">' + t('previewText') + '</div>' +

        '<button id="dt-sp-save" style="width:100%;margin-top:16px;background:#5865F2;color:#fff;border:none;border-radius:6px;padding:11px;font-size:14px;cursor:pointer;">' + t('save') + '</button>' +
        '<div style="font-size:11px;color:#949BA4;margin-top:8px;text-align:center;">' + t('savedTip') + '</div>' +
      '</div>';

    // ---- 绑定事件 ----
    panelEl.querySelector('#dt-sp-close').addEventListener('click', hideSettings);

    // 自动翻译开关：就地刷新外观，不整块重建（重建会冲掉用户还没保存的其它输入）
    panelEl.querySelector('#dt-sp-auto').addEventListener('click', function () {
      setAutoTranslate(!autoTranslateOn, true);
      updateSwitch(this, autoTranslateOn);
    });

    panelEl.querySelector('#dt-sp-opa').addEventListener('input', function () {
      panelEl.querySelector('#dt-sp-ov').textContent = this.value + '%';
      updatePreview();
    });
    panelEl.querySelector('#dt-sp-deb').addEventListener('input', function () {
      panelEl.querySelector('#dt-sp-dv').textContent = this.value + 'ms';
    });
    panelEl.querySelector('#dt-sp-bg').addEventListener('input', function () {
      pickColor(this.value);
    });
    panelEl.querySelector('#dt-sp-swatches').addEventListener('click', function (e) {
      const sw = e.target.closest ? e.target.closest('.dt-sw') : null;
      if (sw) pickColor(sw.getAttribute('data-color'));
    });
    panelEl.querySelector('#dt-sp-test').addEventListener('click', async function () {
      const k = panelEl.querySelector('#dt-sp-key').value.trim();
      const btn = this;
      if (!k) { toast(t('toastEnterKey'), false); return; }
      if (!NATIVE.available()) { toast(t('errNoBridge'), false); return; }
      btn.textContent = t('testing'); btn.disabled = true;
      try {
        await NATIVE.call('test', { apiKey: k }, 25000);
        toast(t('toastKeyOk'), true);
      } catch (err) {
        toast(err.message || String(err), false);
      }
      btn.textContent = t('test'); btn.disabled = false;
    });
    panelEl.querySelector('#dt-sp-save').addEventListener('click', function () {
      const newUi = panelEl.querySelector('#dt-sp-ui').value;
      const btn = this;
      const p = saveConfig({
        apiKey: panelEl.querySelector('#dt-sp-key').value.trim(),
        uiLang: newUi,
        targetLang: panelEl.querySelector('#dt-sp-target').value,
        bubbleBg: editingBg || bubbleBg,
        opacity: String(parseInt(panelEl.querySelector('#dt-sp-opa').value, 10) / 100),
        debounce: String(parseInt(panelEl.querySelector('#dt-sp-deb').value, 10))
      });
      cache.clear();   // 换了目标语言，旧缓存作废

      // 只有确认写进 dt_config.json 才提示"已保存"。
      // 写不进去就明确报错、并且不关面板（方便用户改完重试），
      // 免得出现"提示已保存、重启却全丢"的假成功。
      btn.disabled = true;
      p.then(function () {
        toast(t('toastSaved'), true);
        hideSettings();
      }).catch(function (err) {
        toast(t('toastSaveFail') + ((err && err.message) || err), false, 5000);
      }).then(function () {
        btn.disabled = false;
      });
    });

    // ---- 回填当前值 ----
    const online = NATIVE.available();
    panelEl.querySelector('#dt-sp-bridge').innerHTML =
      '<span style="width:8px;height:8px;border-radius:50%;background:' + (online ? '#43B581' : '#F04747') + ';flex:0 0 auto;"></span>' +
      '<span style="color:' + (online ? '#43B581' : '#F04747') + ';font-weight:600;">' +
      (online ? t('bridgeOn') : t('bridgeOff')) + '</span>' +
      '<span style="color:#949BA4;">' + (online ? t('bridgeHintOn') : t('bridgeHintOff')) + '</span>';

    panelEl.querySelector('#dt-sp-key').value = apiKey;
    panelEl.querySelector('#dt-sp-deb').value = debounceDelay;
    panelEl.querySelector('#dt-sp-dv').textContent = debounceDelay + 'ms';
    panelEl.querySelector('#dt-sp-opa').value = Math.round(bubbleOpacity * 100);
    panelEl.querySelector('#dt-sp-ov').textContent = Math.round(bubbleOpacity * 100) + '%';
    updatePreview();
  }

  // 面板里正在编辑（还没保存）的颜色
  let editingBg = null;

  function pickColor(hex) {
    editingBg = hex;
    panelEl.querySelector('#dt-sp-bg').value = hex;
    panelEl.querySelectorAll('.dt-sw').forEach(function (sw) {
      const on = (sw.getAttribute('data-color').toLowerCase() === hex.toLowerCase());
      sw.style.border = '2px solid ' + (on ? '#5865F2' : 'rgba(255,255,255,.18)');
    });
    updatePreview();
  }

  function updatePreview() {
    const pv = panelEl.querySelector('#dt-sp-preview');
    if (!pv) return;
    const hex = editingBg || bubbleBg;
    const op = parseInt(panelEl.querySelector('#dt-sp-opa').value, 10) / 100;
    pv.style.background = rgbaStr(hex, op);
    pv.style.color = isLightColor(hex) ? '#111214' : '#FFFFFF';
    pv.style.border = '1px solid ' + (isLightColor(hex) ? 'rgba(0,0,0,.10)' : 'rgba(255,255,255,.10)');
  }

  function showSettings() {
    if (!overlayEl) {
      overlayEl = document.createElement('div');
      overlayEl.id = 'dt-settings-overlay';
      overlayEl.style.cssText = 'position:fixed;inset:0;z-index:2147483646;background:rgba(0,0,0,.5);display:none;';
      overlayEl.addEventListener('click', function () { hideSettings(); });
      document.body.appendChild(overlayEl);
    }
    if (!panelEl) {
      panelEl = document.createElement('div');
      panelEl.id = 'dt-settings';
      panelEl.style.cssText = 'position:fixed;z-index:2147483647;top:50%;left:50%;transform:translate(-50%,-50%);width:420px;max-width:calc(100vw - 40px);background:#313338;border-radius:10px;box-shadow:0 12px 40px rgba(0,0,0,.6);font-family:"Microsoft YaHei",system-ui,sans-serif;color:#DBDEE1;display:none;overflow:hidden;';
      document.body.appendChild(panelEl);
    }
    editingBg = bubbleBg;
    renderPanel();          // 每次打开都重建，界面语言切换后文案才会更新

    overlayEl.style.display = 'block';
    panelEl.style.display = 'block';

    // 引导进行中用户跑来开设置面板了 → 聚光灯改打面板里的自动翻译开关
    if (guideStep) guideToSwitch();
  }

  function hideSettings() {
    if (overlayEl) overlayEl.style.display = 'none';
    if (panelEl) panelEl.style.display = 'none';
    // 放弃未保存的颜色改动
    editingBg = null;
    bubbleBg = CONFIG.bubbleBg;
    applyConfig();
  }

  // ==================== 首次使用引导（v2.5）====================
  //
  // 为什么要做：自动翻译**默认是关的**（怕吵到人），可老用户升级上来根本不知道
  // 多了这么个功能。所以第一次跑 v2.5 时主动指给他看。
  //
  // 两步：
  //   1. 小手（👆）指着悬浮球，下面挂个提示卡「新增自动聊天翻译功能 / 右键点一下悬浮球」
  //   2. 他右键点开悬浮球后，小手（👉）挪到菜单里的「开启自动翻译」上，给它打聚光灯
  //      （要是他走的是"设置"那条路，就把聚光灯打到设置面板里的那个开关上）
  //
  // 实现要点：
  //   · 蒙布不"挖洞"，而是一个**带巨大 box-shadow 的透明方块** ——
  //     方块本身没有背景（= 洞，露出下面的目标），shadow 铺满全屏（= 蒙布），
  //     天然就是聚光灯效果，比 clip-path / 多层 div 简单得多。
  //   · 蒙布设 pointer-events:none —— 点击直接穿透到目标上，用户照常右键悬浮球。
  //   · 蒙布和菜单/设置面板的 z-index 都是 2147483647，靠 DOM 顺序压过它们；
  //     所以每次定位都要重新 appendChild 把这三层挪到 body 末尾。
  //   · 只出现一次：显示的同时就写 guideDone=1 存进 dt_config.json，不反复打扰。

  let guideMask = null;
  let guideHand = null;
  let guideTip = null;
  let guideStep = 0;        // 0=没在跑 / 1=指悬浮球 / 2=指自动翻译开关
  let guideCssDone = false;

  function guideCss() {
    if (guideCssDone) return;
    guideCssDone = true;
    const s = document.createElement('style');
    s.id = 'dt-guide-css';
    s.textContent =
      '@keyframes dtHandBobX{0%,100%{transform:translateX(0)}50%{transform:translateX(9px)}}' +
      '@keyframes dtHandBobY{0%,100%{transform:translateY(0)}50%{transform:translateY(-9px)}}' +
      '@keyframes dtRingPulse{0%{box-shadow:0 0 0 0 rgba(88,101,242,.6)}70%{box-shadow:0 0 0 18px rgba(88,101,242,0)}100%{box-shadow:0 0 0 0 rgba(88,101,242,0)}}';
    (document.head || document.documentElement).appendChild(s);
  }

  function ensureGuideEls() {
    if (!guideMask) {
      guideMask = document.createElement('div');
      guideMask.id = 'dt-guide-mask';
      guideMask.style.cssText =
        'position:fixed;z-index:2147483647;pointer-events:none;border-radius:10px;' +
        'box-shadow:0 0 0 9999px rgba(0,0,0,.45);' +
        'transition:left .28s ease,top .28s ease,width .28s ease,height .28s ease;';
      document.body.appendChild(guideMask);
    }
    if (!guideHand) {
      guideHand = document.createElement('div');
      guideHand.id = 'dt-guide-hand';
      guideHand.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;';
      const inner = document.createElement('span');
      inner.textContent = '👆';
      inner.style.cssText =
        'display:inline-block;font-size:36px;line-height:1;' +
        'filter:drop-shadow(0 2px 4px rgba(0,0,0,.55));' +
        'animation:dtHandBobY .9s ease-in-out infinite;';
      guideHand.appendChild(inner);
      document.body.appendChild(guideHand);
    }
    if (!guideTip) {
      guideTip = document.createElement('div');
      guideTip.id = 'dt-guide-tip';
      guideTip.style.cssText =
        'position:fixed;z-index:2147483647;width:220px;background:#5865F2;color:#fff;border-radius:10px;' +
        'padding:12px 14px;font-family:"Microsoft YaHei",system-ui,sans-serif;font-size:13px;line-height:1.5;' +
        'box-shadow:0 10px 30px rgba(0,0,0,.45);';
      document.body.appendChild(guideTip);
    }
    // 关键：按 mask → hand → tip 的顺序重新挂到 body 末尾，
    // 保证这三层压得住菜单（2147483647）和设置面板（2147483647）
    document.body.appendChild(guideMask);
    document.body.appendChild(guideHand);
    document.body.appendChild(guideTip);
  }

  // 把蒙布摆成"目标位置一个洞"的样子
  function guideSpotlight(rect, pad) {
    pad = pad || 8;
    guideMask.style.left = (rect.left - pad) + 'px';
    guideMask.style.top = (rect.top - pad) + 'px';
    guideMask.style.width = (rect.width + pad * 2) + 'px';
    guideMask.style.height = (rect.height + pad * 2) + 'px';
  }

  // 小手：pointUp=true 放目标正下方指上去（👆）；false 放目标左侧指过去（👉）
  function guideHandAt(rect, pointUp) {
    const size = 36;
    const inner = guideHand.firstChild;
    let left, top;
    if (pointUp) {
      left = rect.left + rect.width / 2 - size / 2;
      top = rect.bottom + 8;
      guideHand.style.transform = 'none';
    } else {
      left = rect.left - size - 6;
      top = rect.top + rect.height / 2 - size / 2;
      if (left < 8) { left = rect.right + 6; guideHand.style.transform = 'scaleX(-1)'; }
      else guideHand.style.transform = 'none';
    }
    guideHand.style.left = Math.max(8, left) + 'px';
    guideHand.style.top = Math.max(8, top) + 'px';
    if (inner) {
      inner.textContent = pointUp ? '👆' : '👉';
      inner.style.animation = (pointUp ? 'dtHandBobY' : 'dtHandBobX') + ' .9s ease-in-out infinite';
    }
  }

  function guideTipAt(rect, title, desc, showSkip, opts) {
    opts = opts || {};
    guideTip.innerHTML =
      '<div style="font-weight:700;font-size:14px;margin-bottom:5px;">' + title + '</div>' +
      (desc ? '<div style="opacity:.92;font-size:12px;">' + desc + '</div>' : '') +
      (showSkip
        ? '<button id="dt-guide-skip" style="margin-top:10px;width:100%;background:rgba(255,255,255,.2);' +
          'color:#fff;border:none;border-radius:6px;padding:7px;font-size:12px;cursor:pointer;">' +
          t('guideSkip') + '</button>'
        : '');
    guideTip.style.display = 'block';
    const tw = guideTip.offsetWidth;
    const th = guideTip.offsetHeight;
    let left, top;
    if (opts.preferLeft && rect.left - tw - 18 > 10) {
      // 放到目标左侧（菜单那一列别被挡住）
      left = rect.left - tw - 18;
      top = rect.top + rect.height / 2 - th / 2;
    } else {
      left = rect.left + rect.width / 2 - tw / 2;
      top = rect.bottom + (opts.gap === undefined ? 14 : opts.gap);
      if (top + th > viewportH() - 10) top = rect.top - th - 14;
    }
    left = Math.max(10, Math.min(viewportW() - tw - 10, left));
    top = Math.max(10, Math.min(viewportH() - th - 10, top));
    guideTip.style.left = left + 'px';
    guideTip.style.top = top + 'px';
    const sk = guideTip.querySelector('#dt-guide-skip');
    if (sk) sk.addEventListener('click', function () { guideFinish(); });
  }

  function guideStep1() {
    if (!ballEl) return;
    guideCss();
    ensureGuideEls();
    guideStep = 1;
    if (menuEl) menuEl.style.display = 'none';
    const r = ballEl.getBoundingClientRect();
    guideMask.style.display = 'block';
    guideSpotlight(r, 12);
    guideHand.style.display = 'block';
    guideHandAt(r, true);
    // 小手在球下方，提示卡再往下一点，别压住小手
    guideTipAt(r, t('guideTitle'), t('guideStep1'), true, { gap: 56 });
  }

  function guideToStep2() {
    if (guideStep !== 1) return;
    const item = menuEl ? menuEl.querySelector('#dt-menu-auto') : null;
    if (!item) return;   // 菜单还没出来就保持第 1 步
    guideStep = 2;
    const r = item.getBoundingClientRect();
    guideMask.style.display = 'block';
    guideSpotlight(r, 5);
    guideHand.style.display = 'block';
    guideHandAt(r, false);
    guideTipAt(r, t('guideTitle'), t('guideStep2'), false, { preferLeft: true });
  }

  // 用户没走菜单、直接开了设置面板 → 把聚光灯打到面板里的开关上
  function guideToSwitch() {
    const sw = panelEl ? panelEl.querySelector('#dt-sp-auto') : null;
    if (!sw) return;
    guideStep = 2;
    const r = sw.getBoundingClientRect();
    guideMask.style.display = 'block';
    guideSpotlight(r, 8);
    guideHand.style.display = 'block';
    guideHandAt(r, false);
    guideTipAt(r, t('guideTitle'), t('guideStep2'), false, { preferLeft: true });
  }

  function guideRefresh() {
    if (guideStep === 1) { guideStep1(); return; }
    if (guideStep !== 2) return;
    const sw = (panelEl && panelEl.style.display === 'block')
      ? panelEl.querySelector('#dt-sp-auto')
      : (menuEl ? menuEl.querySelector('#dt-menu-auto') : null);
    if (!sw) return;
    const r = sw.getBoundingClientRect();
    guideSpotlight(r, 5);
    guideHandAt(r, false);
    guideTipAt(r, t('guideTitle'), t('guideStep2'), false, { preferLeft: true });
  }

  function guideFinish() {
    guideStep = 0;
    if (guideMask) guideMask.style.display = 'none';
    if (guideHand) guideHand.style.display = 'none';
    if (guideTip) guideTip.style.display = 'none';
  }

  function maybeShowGuide() {
    if (guideStep) return;
    if (CONFIG.guideDone === '1') return;   // 看过了
    if (!ballEl) return;
    // 显示的同时就记下"看过了" —— 免得用户没点关闭，下次启动又冒出来烦人
    CONFIG.guideDone = '1';
    saveConfigQuiet({ guideDone: '1' });
    guideStep1();
  }

  window.addEventListener('resize', function () {
    if (guideStep) guideRefresh();
  });

  // ==================== 启动 ====================

  let booted = false;

  function init() {
    if (booted) return;
    if (!document.body) { setTimeout(init, 200); return; }
    booted = true;
    createBall();
    configReady = loadConfig();
    // v2.5：首次使用引导。等配置读完再判断 —— 否则 CONFIG.guideDone 还是空的，
    // 老用户每次启动都会被指一遍。延迟 1.5 秒，等 Discord 界面和悬浮球都稳了再出。
    configReady.then(function () {
      setTimeout(maybeShowGuide, 1500);
    });
    console.log('[DT] Discord 翻译助手 ' + window.__DT_VERSION__ + ' 已注入 (CDP + 原生桥接)');
  }

  if (document.body) {
    init();
  } else {
    document.addEventListener('DOMContentLoaded', init);
    // 兜底：万一 DOMContentLoaded 迟迟不来（页面卡在 loading、窗口最小化被节流等），
    // 300ms 后自己轮询重试，避免"注入成功但没有悬浮球"
    setTimeout(init, 300);
  }
})();
