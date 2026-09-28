/**
 * inject.js - Discord 翻译助手（CDP 注入版）
 * 通过 Chrome DevTools Protocol 注入到 Discord 页面运行
 * 不依赖 Chrome 扩展机制
 */

(function () {
  'use strict';

  if (window.__DT_INJECTED__) {
    console.log('[DT] 已注入，跳过');
    return;
  }
  window.__DT_INJECTED__ = true;

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
    ballY: ''
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
        p.reject(new Error('桥接返回数据异常'));
        return;
      }
      if (data && data.ok) p.resolve(data.result);
      else p.reject(new Error((data && data.error) || '未知错误'));
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
          reject(new Error('桥接调用失败: ' + e.message));
          return;
        }
        setTimeout(function () {
          if (pending[id]) {
            delete pending[id];
            reject(new Error('翻译服务响应超时，请检查 launcher.exe 是否在运行'));
          }
        }, timeoutMs || 40000);
      });
    }

    return { call: call, available: available };
  })();

  // ===== 配置同步（读写 launcher.exe 的 dt_config.json）=====
  let configReady = Promise.resolve();

  function applyConfig() {
    translationEnabled = CONFIG.enabled !== '0';
    apiKey = CONFIG.apiKey || '';
    const d = parseInt(CONFIG.debounce, 10);
    debounceDelay = isNaN(d) ? 300 : d;
    const o = parseFloat(CONFIG.opacity);
    bubbleOpacity = isNaN(o) ? 0.75 : o;
    if (ballEl && typeof updateBallState === 'function') updateBallState();
    if (bubbleEl) bubbleEl.style.background = 'rgba(0,0,0,' + bubbleOpacity + ')';
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

  // ===== 全局状态 =====
  let translationEnabled = true;
  let apiKey = '';
  let debounceDelay = 300;
  let bubbleOpacity = 0.75;

  let debounceTimer = null;
  let hideTimer = null;
  let currentHoverEl = null;
  const cache = new Map();
  const CACHE_MAX = 1000;
  const inFlight = new Map();

  // ==================== 翻译模块 ====================

  function getCached(text) {
    if (cache.has(text)) {
      const v = cache.get(text);
      cache.delete(text);
      cache.set(text, v);
      return v;
    }
    return null;
  }

  function setCache(text, translation) {
    if (cache.size >= CACHE_MAX) {
      cache.delete(cache.keys().next().value);
    }
    cache.set(text, translation);
  }

  async function doTranslate(text) {
    await configReady;
    if (!apiKey) {
      throw new Error('未设置 API Key，请右键悬浮球 → 设置 API Key');
    }
    if (!NATIVE.available()) {
      throw new Error('翻译服务未连接，请重新运行 launcher.exe');
    }
    // 走 launcher.exe 代发请求（绕开页面 CSP）
    return await NATIVE.call('translate', {
      apiKey: apiKey,
      text: text.substring(0, 2000),
      model: CONFIG.model || 'deepseek-chat'
    }, 40000);
  }

  // ==================== 气泡模块 ====================

  let bubbleEl = null;
  let bubbleTargetEl = null;
  let bubbleHideTimer = null;

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
      'background:rgba(0,0,0,' + bubbleOpacity + ')',
      'border-radius:8px',
      'padding:10px 14px',
      'box-shadow:0 4px 12px rgba(0,0,0,.4)',
      'opacity:0',
      'transition:opacity .15s ease-in-out',
      'font-family:"Microsoft YaHei","PingFang SC",sans-serif',
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
    if (below) {
      arrow.style.top = '-8px';
      arrow.style.bottom = 'auto';
      arrow.style.borderBottom = '8px solid rgba(0,0,0,' + bubbleOpacity + ')';
      arrow.style.borderTop = 'none';
    } else {
      arrow.style.bottom = '-8px';
      arrow.style.top = 'auto';
      arrow.style.borderTop = '8px solid rgba(0,0,0,' + bubbleOpacity + ')';
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
    const isError = state === 'error';
    const isLoading = state === true || state === 'loading';
    txt.textContent = text;
    txt.style.color = isError ? '#FFB4B4' : (isLoading ? 'rgba(255,255,255,.65)' : '#fff');
    txt.style.fontStyle = isLoading ? 'italic' : 'normal';
    txt.style.fontWeight = isError ? '600' : '400';
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

  function isEnglish(text) {
    if (!text || text.length < 2) return false;
    const clean = text.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\uFE0F]/gu, '').trim();
    if (clean.length < 2) return false;
    const latin = (clean.match(/[a-zA-Z]/g) || []).length;
    const cjk = (clean.match(/[\u4e00-\u9fff]/g) || []).length;
    const total = latin + cjk;
    if (total === 0) return false;
    return (latin / total > 0.6) && (cjk / total < 0.2);
  }

  // ==================== 鼠标事件 ====================

  document.addEventListener('mouseover', function (e) {
    if (!translationEnabled) return;
    if (e.target.closest && e.target.closest('#dt-ball, #dt-settings, #dt-menu, #dt-settings-overlay')) return;

    const msgEl = findMessageEl(e.target);
    if (!msgEl) return;
    const text = (msgEl.textContent || '').trim();
    if (!isEnglish(text)) return;

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
      showBubble(msgEl, translation, false);
      return;
    }
    if (inFlight.has(text)) {
      try {
        translation = await inFlight.get(text);
        if (currentHoverEl === msgEl) showBubble(msgEl, translation, false);
      } catch (e) {}
      return;
    }
    showBubble(msgEl, '正在翻译...', true);
    const p = doTranslate(text).then(function (r) {
      setCache(text, r);
      return r;
    }).finally(function () {
      inFlight.delete(text);
    });
    inFlight.set(text, p);
    try {
      translation = await p;
      if (currentHoverEl === msgEl) showBubble(msgEl, translation, false);
    } catch (err) {
      if (currentHoverEl === msgEl) {
        // 错误用高亮红字显示，并给足阅读时间（不是"加载中"那种灰斜体）
        showBubble(msgEl, err.message || '翻译失败', 'error');
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
    const t = document.createElement('div');
    t.style.cssText = 'position:fixed;z-index:2147483647;top:24px;left:50%;transform:translateX(-50%);background:' + (ok ? 'rgba(67,181,129,.95)' : 'rgba(240,71,71,.95)') + ';color:#fff;padding:9px 22px;border-radius:22px;font-size:14px;font-family:"Microsoft YaHei",sans-serif;opacity:0;transition:opacity .3s;pointer-events:none;box-shadow:0 4px 16px rgba(0,0,0,.4);';
    t.textContent = msg;
    document.body.appendChild(t);
    void t.offsetHeight;
    t.style.opacity = '1';
    setTimeout(function () {
      t.style.opacity = '0';
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 300);
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
    ballEl.title = 'Discord 翻译助手';
    ballEl.style.cssText = 'position:fixed;z-index:2147483645;width:40px;height:40px;border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;user-select:none;opacity:.3;transition:opacity .3s,transform .2s,box-shadow .3s,width .2s,height .2s;box-shadow:0 2px 8px rgba(0,0,0,.3);color:#fff;font-size:17px;font-weight:600;font-family:"Microsoft YaHei",sans-serif;';
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
        toast(translationEnabled ? '翻译已开启' : '翻译已关闭', true);
      }
    });

    ballEl.addEventListener('dblclick', function (e) {
      e.preventDefault();
      collapsed = !collapsed;
      if (collapsed) {
        ballEl.style.width = '12px';
        ballEl.style.height = '12px';
        ballEl.style.opacity = '.25';
        ballEl.textContent = '';
        toast('已收起，双击小点展开', true);
      } else {
        ballEl.style.width = '40px';
        ballEl.style.height = '40px';
        ballEl.style.opacity = '.3';
        ballEl.textContent = '译';
      }
    });

    ballEl.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      e.stopPropagation();
      showMenu(e.clientX, e.clientY);
    });

    resetAutoHide();
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
      menuEl.style.cssText = 'position:fixed;z-index:2147483647;display:none;background:#2B2D31;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.5);padding:6px 0;min-width:190px;font-family:"Microsoft YaHei",sans-serif;font-size:13px;';
      document.body.appendChild(menuEl);
    }
    menuEl.innerHTML =
      '<div style="padding:6px 14px 2px;color:#949BA4;font-size:11px;">Discord 翻译助手</div>' +
      '<div style="padding:2px 14px 8px;color:#B5BAC1;font-size:11px;display:flex;align-items:center;gap:6px;">' +
        '<span style="width:8px;height:8px;border-radius:50%;background:' + (translationEnabled ? '#43B581' : '#F04747') + ';"></span>' +
        (translationEnabled ? '翻译功能已开启' : '翻译功能已关闭') +
      '</div>' +
      '<div style="padding:0 14px 8px;color:#B5BAC1;font-size:11px;display:flex;align-items:center;gap:6px;">' +
        '<span style="width:8px;height:8px;border-radius:50%;background:' + (NATIVE.available() ? '#43B581' : '#F04747') + ';"></span>' +
        (NATIVE.available() ? '翻译服务已连接' : '翻译服务未连接') +
      '</div>' +
      '<div style="height:1px;background:rgba(255,255,255,.08);margin:4px 8px;"></div>' +
      menuItem('toggle', translationEnabled ? '关闭翻译' : '开启翻译') +
      menuItem('settings', '设置 API Key') +
      menuItem('clear', '清空翻译缓存') +
      '<div style="height:1px;background:rgba(255,255,255,.08);margin:4px 8px;"></div>' +
      menuItem('collapse', collapsed ? '展开悬浮球' : '收起悬浮球') +
      '<div style="height:1px;background:rgba(255,255,255,.08);margin:4px 8px;"></div>' +
      menuItem('quit', '退出翻译助手') +
      '<div data-act="about" style="padding:8px 14px;color:#949BA4;font-size:12px;cursor:pointer;">关于 v2.2</div>';

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
      toast(translationEnabled ? '翻译已开启' : '翻译已关闭', true);
    } else if (act === 'settings') {
      showSettings();
    } else if (act === 'clear') {
      cache.clear();
      toast('翻译缓存已清空', true);
    } else if (act === 'collapse') {
      collapsed = !collapsed;
      if (collapsed) {
        ballEl.style.width = '12px'; ballEl.style.height = '12px';
        ballEl.style.opacity = '.25'; ballEl.textContent = '';
      } else {
        ballEl.style.width = '40px'; ballEl.style.height = '40px';
        ballEl.style.opacity = '.3'; ballEl.textContent = '译';
      }
    } else if (act === 'quit') {
      if (!NATIVE.available()) {
        toast('翻译服务未连接，可直接关闭 launcher.exe 窗口', false);
        return;
      }
      NATIVE.call('quit', {}, 5000).catch(function () {});
      toast('翻译助手已退出', true);
      setTimeout(function () {
        if (ballEl && ballEl.parentNode) ballEl.parentNode.removeChild(ballEl);
        if (menuEl && menuEl.parentNode) menuEl.parentNode.removeChild(menuEl);
        hideBubble();
      }, 400);
    } else if (act === 'about') {
      toast('Discord 翻译助手 v2.2 | 悬停英文消息自动翻译', true);
    }
  }

  // ==================== 设置面板 ====================

  let overlayEl = null;
  let panelEl = null;

  function showSettings() {
    if (!overlayEl) {
      overlayEl = document.createElement('div');
      overlayEl.id = 'dt-settings-overlay';
      overlayEl.style.cssText = 'position:fixed;inset:0;z-index:2147483646;background:rgba(0,0,0,.5);display:none;';
      overlayEl.addEventListener('click', function () { hideSettings(); });
      document.body.appendChild(overlayEl);

      panelEl = document.createElement('div');
      panelEl.id = 'dt-settings';
      panelEl.style.cssText = 'position:fixed;z-index:2147483647;top:50%;left:50%;transform:translate(-50%,-50%);width:400px;max-width:calc(100vw - 40px);background:#313338;border-radius:10px;box-shadow:0 12px 40px rgba(0,0,0,.6);font-family:"Microsoft YaHei",sans-serif;color:#DBDEE1;display:none;overflow:hidden;';
      panelEl.innerHTML =
        '<div style="display:flex;justify-content:space-between;align-items:center;padding:14px 18px;background:#2B2D31;">' +
          '<span style="font-size:15px;font-weight:600;color:#F2F3F5;">Discord 翻译助手 v2.2 - 设置</span>' +
          '<span id="dt-sp-close" style="font-size:22px;color:#949BA4;cursor:pointer;line-height:1;">×</span>' +
        '</div>' +
        '<div style="padding:18px;">' +
          '<div id="dt-sp-bridge" style="display:flex;align-items:center;gap:6px;font-size:12px;padding:8px 10px;border-radius:6px;background:#1E1F22;margin-bottom:16px;"></div>' +
          '<div style="font-size:13px;color:#B5BAC1;margin-bottom:8px;">DeepSeek API Key</div>' +
          '<div style="display:flex;gap:8px;">' +
            '<input id="dt-sp-key" type="password" placeholder="sk-xxxxxxxx" style="flex:1;background:#1E1F22;border:1px solid #0E0F11;border-radius:6px;padding:9px 12px;color:#DBDEE1;font-size:13px;outline:none;">' +
            '<button id="dt-sp-test" style="background:#4E5058;color:#fff;border:none;border-radius:6px;padding:9px 12px;font-size:13px;cursor:pointer;white-space:nowrap;">测试</button>' +
          '</div>' +
          '<div style="font-size:11px;color:#949BA4;margin-top:6px;">获取：platform.deepseek.com 注册后创建</div>' +
          '<div style="font-size:13px;color:#B5BAC1;margin:16px 0 8px;">触发延迟 <span id="dt-sp-dv" style="color:#5865F2;font-weight:600;">300ms</span></div>' +
          '<input id="dt-sp-deb" type="range" min="100" max="1000" step="100" style="width:100%;accent-color:#5865F2;">' +
          '<div style="font-size:13px;color:#B5BAC1;margin:16px 0 8px;">气泡透明度 <span id="dt-sp-ov" style="color:#5865F2;font-weight:600;">75%</span></div>' +
          '<input id="dt-sp-opa" type="range" min="40" max="95" step="5" style="width:100%;accent-color:#5865F2;">' +
          '<button id="dt-sp-save" style="width:100%;margin-top:20px;background:#5865F2;color:#fff;border:none;border-radius:6px;padding:11px;font-size:14px;cursor:pointer;">保存设置</button>' +
        '</div>';
      document.body.appendChild(panelEl);

      panelEl.querySelector('#dt-sp-close').addEventListener('click', hideSettings);
      panelEl.querySelector('#dt-sp-deb').addEventListener('input', function () {
        panelEl.querySelector('#dt-sp-dv').textContent = this.value + 'ms';
      });
      panelEl.querySelector('#dt-sp-opa').addEventListener('input', function () {
        panelEl.querySelector('#dt-sp-ov').textContent = this.value + '%';
      });
      panelEl.querySelector('#dt-sp-test').addEventListener('click', async function () {
        const k = panelEl.querySelector('#dt-sp-key').value.trim();
        const btn = this;
        if (!k) { toast('请先输入 API Key', false); return; }
        if (!NATIVE.available()) { toast('翻译服务未连接，请重新运行 launcher.exe', false); return; }
        btn.textContent = '测试中'; btn.disabled = true;
        try {
          await NATIVE.call('test', { apiKey: k }, 25000);
          toast('API Key 有效，连接正常！', true);
        } catch (err) {
          toast(err.message || String(err), false);
        }
        btn.textContent = '测试'; btn.disabled = false;
      });
      panelEl.querySelector('#dt-sp-save').addEventListener('click', function () {
        saveConfig({
          apiKey: panelEl.querySelector('#dt-sp-key').value.trim(),
          debounce: String(parseInt(panelEl.querySelector('#dt-sp-deb').value, 10)),
          opacity: String(parseInt(panelEl.querySelector('#dt-sp-opa').value, 10) / 100)
        });
        toast('设置已保存', true);
        hideSettings();
      });
    }

    const bs = panelEl.querySelector('#dt-sp-bridge');
    const online = NATIVE.available();
    bs.innerHTML =
      '<span style="width:8px;height:8px;border-radius:50%;background:' + (online ? '#43B581' : '#F04747') + ';flex:0 0 auto;"></span>' +
      '<span style="color:' + (online ? '#43B581' : '#F04747') + ';font-weight:600;">' +
      (online ? '翻译服务已连接' : '翻译服务未连接') + '</span>' +
      '<span style="color:#949BA4;">' + (online ? '（请求由本机代发，已绕开页面限制）' : '（请重新运行 launcher.exe）') + '</span>';

    panelEl.querySelector('#dt-sp-key').value = apiKey;
    panelEl.querySelector('#dt-sp-deb').value = debounceDelay;
    panelEl.querySelector('#dt-sp-dv').textContent = debounceDelay + 'ms';
    panelEl.querySelector('#dt-sp-opa').value = Math.round(bubbleOpacity * 100);
    panelEl.querySelector('#dt-sp-ov').textContent = Math.round(bubbleOpacity * 100) + '%';

    overlayEl.style.display = 'block';
    panelEl.style.display = 'block';
  }

  function hideSettings() {
    if (overlayEl) overlayEl.style.display = 'none';
    if (panelEl) panelEl.style.display = 'none';
  }

  // ==================== 启动 ====================

  function init() {
    createBall();
    configReady = loadConfig();
    console.log('[DT] Discord 翻译助手 v2.2 已注入 (CDP + 原生桥接)');
  }

  if (document.body) {
    init();
  } else {
    document.addEventListener('DOMContentLoaded', init);
  }
})();
