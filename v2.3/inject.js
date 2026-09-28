/**
 * inject.js - Discord 翻译助手（CDP 注入版）v2.3
 * 通过 Chrome DevTools Protocol 注入到 Discord 页面运行
 * 不依赖 Chrome 扩展机制
 *
 * v2.3 新增：
 *   1. 界面语言（中文 / English）—— 外国同事也能看懂菜单和设置
 *   2. 目标语言（13 种）—— 想翻成什么语言就翻成什么语言
 *   3. 同语言不翻译 —— 悬停文本已是目标语言时，直接不发请求（更快）
 *   4. 气泡调色板 + 透明度滑块
 */

(function () {
  'use strict';

  if (window.__DT_INJECTED__) {
    console.log('[DT] 已注入，跳过');
    return;
  }
  window.__DT_INJECTED__ = true;
  window.__DT_VERSION__ = 'v2.3';

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
      about: '关于 v2.3',
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
      testing: '测试中',
      test: '测试',
      aboutText: 'Discord 翻译助手 v2.3 | 悬停消息自动翻译',
      translating: '正在翻译…',
      errNoKey: '未设置 API Key，请右键悬浮球 → 设置',
      errNoBridge: '翻译服务未连接，请重新运行 launcher.exe',
      errGeneric: '翻译失败',
      errBridgeData: '桥接返回数据异常',
      errBridgeCall: '桥接调用失败: ',
      errTimeout: '翻译服务响应超时，请检查 launcher.exe 是否在运行',
      errUnknown: '未知错误',
      settingsTitle: 'Discord 翻译助手 v2.3 · 设置',
      secUiLang: '界面语言',
      secTarget: '目标语言',
      targetHint: '鼠标悬停的文本只要不是这个语言，就自动翻译成它',
      secApiKey: 'DeepSeek API Key',
      keyHelp: '获取：platform.deepseek.com 注册后创建',
      secColor: '气泡颜色',
      customColor: '自定义',
      secOpacity: '气泡透明度',
      secDelay: '触发延迟',
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
      about: 'About v2.3',
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
      testing: 'Testing',
      test: 'Test',
      aboutText: 'Discord Translator v2.3 | Hover a message to translate',
      translating: 'Translating…',
      errNoKey: 'No API key — right-click the ball → Settings',
      errNoBridge: 'Service not connected — please run launcher.exe again',
      errGeneric: 'Translation failed',
      errBridgeData: 'Bad data returned from bridge',
      errBridgeCall: 'Bridge call failed: ',
      errTimeout: 'Service timed out — is launcher.exe still running?',
      errUnknown: 'Unknown error',
      settingsTitle: 'Discord Translator v2.3 · Settings',
      secUiLang: 'Interface language',
      secTarget: 'Target language',
      targetHint: 'Anything hovered that is not in this language gets translated into it',
      secApiKey: 'DeepSeek API Key',
      keyHelp: 'Create one at platform.deepseek.com',
      secColor: 'Bubble color',
      customColor: 'Custom',
      secOpacity: 'Bubble opacity',
      secDelay: 'Hover delay',
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
    ballX: '',
    ballY: '',
    uiLang: 'zh',            // 界面语言
    targetLang: 'zh',        // 目标语言
    bubbleBg: '#000000'      // 气泡背景色
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
    }
    updateBubbleStyle();
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

  function saveConfig(patch) {
    Object.keys(patch).forEach(function (k) {
      CONFIG[k] = String(patch[k]);
      storeSet(k, CONFIG[k]);
    });
    applyConfig();
    if (!NATIVE.available()) return Promise.resolve();
    return NATIVE.call('setConfig', { config: CONFIG }, 8000).catch(function () {});
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

  // ==================== 鼠标事件 ====================

  document.addEventListener('mouseover', function (e) {
    if (!translationEnabled) return;
    if (e.target.closest && e.target.closest('#dt-ball, #dt-settings, #dt-menu, #dt-settings-overlay')) return;

    const msgEl = findMessageEl(e.target);
    if (!msgEl) return;
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

  function toast(msg, ok) {
    const tt = document.createElement('div');
    tt.style.cssText = 'position:fixed;z-index:2147483647;top:24px;left:50%;transform:translateX(-50%);background:' + (ok ? 'rgba(67,181,129,.95)' : 'rgba(240,71,71,.95)') + ';color:#fff;padding:9px 22px;border-radius:22px;font-size:14px;font-family:"Microsoft YaHei",system-ui,sans-serif;opacity:0;transition:opacity .3s;pointer-events:none;box-shadow:0 4px 16px rgba(0,0,0,.4);max-width:70vw;';
    tt.textContent = msg;
    document.body.appendChild(tt);
    void tt.offsetHeight;
    tt.style.opacity = '1';
    setTimeout(function () {
      tt.style.opacity = '0';
      setTimeout(function () { if (tt.parentNode) tt.parentNode.removeChild(tt); }, 300);
    }, 1800);
  }

  function updateBallState() {
    if (!ballEl) return;
    ballEl.style.border = translationEnabled ? '2px solid #43B581' : '2px solid #F04747';
    ballEl.style.background = translationEnabled
      ? 'linear-gradient(135deg,#5865F2,#4752C4)'
      : 'linear-gradient(135deg,#555,#383838)';
  }

  function createBall() {
    if (ballEl) return;
    ballEl = document.createElement('div');
    ballEl.id = 'dt-ball';
    ballEl.title = t('appName');
    ballEl.style.cssText = 'position:fixed;z-index:2147483645;width:40px;height:40px;border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;user-select:none;opacity:.3;transition:opacity .3s,transform .2s,box-shadow .3s,width .2s,height .2s;box-shadow:0 2px 8px rgba(0,0,0,.3);color:#fff;font-size:17px;font-weight:600;font-family:"Microsoft YaHei",system-ui,sans-serif;';
    ballEl.textContent = '译';
    // 恢复位置
    const px = CONFIG.ballX || '';
    const py = CONFIG.ballY || '';
    if (px !== '' && py !== '') {
      ballEl.style.left = px + 'px';
      ballEl.style.top = py + 'px';
    } else {
      ballEl.style.right = '20px';
      ballEl.style.bottom = '20px';
    }
    document.body.appendChild(ballEl);
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
      let nl = Math.max(0, Math.min(window.innerWidth - ballEl.offsetWidth, bsl + dx));
      let nt = Math.max(0, Math.min(window.innerHeight - ballEl.offsetHeight, bst + dy));
      ballEl.style.left = nl + 'px';
      ballEl.style.top = nt + 'px';
      ballEl.style.right = 'auto';
      ballEl.style.bottom = 'auto';
    });

    document.addEventListener('mouseup', function (e) {
      if (!dragging) return;
      dragging = false;
      if (moved) {
        const r = ballEl.getBoundingClientRect();
        saveConfig({ ballX: Math.round(r.left), ballY: Math.round(r.top) });
      } else if (e.button === 0) {
        translationEnabled = !translationEnabled;
        saveConfig({ enabled: translationEnabled ? '1' : '0' });
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
    setTimeout(function () {
      document.addEventListener('click', function h() { menuEl.style.display = 'none'; document.removeEventListener('click', h); }, { once: true });
    }, 10);
  }

  function menuItem(act, label) {
    return '<div data-act="' + act + '" style="padding:8px 14px;color:#DBDEE1;cursor:pointer;">' + label + '</div>';
  }

  function handleAction(act) {
    if (act === 'toggle') {
      translationEnabled = !translationEnabled;
      saveConfig({ enabled: translationEnabled ? '1' : '0' });
      updateBallState();
      if (!translationEnabled) hideBubble();
      toast(translationEnabled ? t('toastOn') : t('toastOff'), true);
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
      saveConfig({
        apiKey: panelEl.querySelector('#dt-sp-key').value.trim(),
        uiLang: newUi,
        targetLang: panelEl.querySelector('#dt-sp-target').value,
        bubbleBg: editingBg || bubbleBg,
        opacity: String(parseInt(panelEl.querySelector('#dt-sp-opa').value, 10) / 100),
        debounce: String(parseInt(panelEl.querySelector('#dt-sp-deb').value, 10))
      });
      cache.clear();   // 换了目标语言，旧缓存作废
      toast(t('toastSaved'), true);
      hideSettings();
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
  }

  function hideSettings() {
    if (overlayEl) overlayEl.style.display = 'none';
    if (panelEl) panelEl.style.display = 'none';
    // 放弃未保存的颜色改动
    editingBg = null;
    bubbleBg = CONFIG.bubbleBg;
    applyConfig();
  }

  // ==================== 启动 ====================

  let booted = false;

  function init() {
    if (booted) return;
    if (!document.body) { setTimeout(init, 200); return; }
    booted = true;
    createBall();
    configReady = loadConfig();
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
