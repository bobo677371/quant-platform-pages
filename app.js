/* =============================================================================
 * quant-platform · PWA 前端逻辑（纯原生 JS，无框架、无外链、不联网构建）
 *
 * 数据契约：docs/pwa_data_contract.md
 *   - 只读 data/*.json，统一 {"meta": {...}, "data": {...}}
 *   - 缺失一律 null：页面显示「—」，不得用 0 填充
 *   - 数组按 trade_dates 等长对齐：某面板缺数据时保留日期、写 null
 *
 * 加载策略：
 *   1) fetch(url, {cache:'no-store'})
 *   2) 404            → 「该模块尚未生成」空态（不是报错）
 *   3) 网络/其它失败  → caches.match() 回退，并标记 stale 提示
 * ========================================================================== */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ 常量 */
  var FILES = {
    market: 'data/market_overview.json',
    breadth: 'data/market_breadth.json',
    sectorsIndustry: 'data/sectors_industry.json',
    sectorsConcept: 'data/sectors_concept.json',
    candidatesShort: 'data/candidates_short.json',
    candidatesMedium: 'data/candidates_medium.json',
    limit: 'data/limit_ecology.json',
    research: 'data/research_status.json',
    system: 'data/system_health.json'
  };

  var INDEX_LIST = [
    { code: '000001.SH', name: '上证指数' },
    { code: '000300.SH', name: '沪深300' },
    { code: '399001.SZ', name: '深证成指' },
    { code: '399006.SZ', name: '创业板指' }
  ];

  var RANGES = [20, 60, 120, 250];

  var COMPONENT_ORDER = ['breadth', 'limit_ecology', 'trend', 'liquidity', 'risk_appetite'];

  var COMPONENT_LABELS = {
    breadth: '市场广度',
    limit_ecology: '涨停生态',
    trend: '趋势',
    liquidity: '流动性',
    risk_appetite: '风险偏好'
  };

  var MODE_LABELS = {
    LIVE_CURRENT: '实时',
    LIVE: '实时',
    CLOSE_FINAL: '收盘',
    CLOSE: '收盘',
    DELAYED: '延迟',
    APPROX_HISTORY: '近似历史',
    DEGRADED_CACHE: '降级缓存',
    STALE: '降级缓存'
  };

  var STATUS_LABELS = {
    ok: '正常',
    partial: '部分缺失',
    degraded: '降级',
    stale: '已过期',
    unavailable: '不可用',
    unknown: '未知'
  };

  var THEME_LABELS = { auto: '跟随系统', light: '浅色', dark: '深色' };

  var DIM_LABELS = {
    low_position: '低位',
    quality: '质量',
    fundamental_quality: '质量',
    valuation: '估值',
    technical: '技术',
    technical_stabilization: '技术企稳',
    sector: '板块',
    sector_context: '板块',
    logic: '逻辑',
    logic_evidence: '逻辑'
  };

  var FIELD_LABELS = {
    dataset_id: '数据集',
    dataset: '数据集',
    status: '状态',
    rows: '行数',
    as_of: '时点',
    ingested_at: '入库时间',
    age_hours: '滞后(小时)',
    quality_tier: '质量等级',
    warnings: '警告',
    run_id: '任务号',
    job: '任务',
    started_at: '开始',
    finished_at: '结束',
    duration_s: '耗时(秒)',
    model_version: '模型版本',
    strategy_id: '策略',
    name: '名称',
    note: '说明',
    notes: '说明',
    samples: '样本量',
    sample_n: '样本量',
    start: '开始',
    end: '结束',
    window: '窗口',
    verdict: '结论',
    hit_rate: '命中率',
    max_drawdown: '最大回撤',
    factor_id: '因子',
    definition: '定义',
    source: '来源',
    updated_at: '更新时间',
    date: '日期',
    signals: '标的数'
  };

  var STATE = {
    page: 'overview',
    theme: 'auto',
    index: '000001.SH',
    range: 120,
    horizon: 'short',
    sectorTab: 'industry',
    chart: null,
    chartData: null,
    chartObserver: null,
    chartMsg: false
  };

  var DATA_CACHE = {};
  var PAGE_READY = {
    overview: false, sectors: false, candidates: false,
    limit: false, research: false, system: false
  };

  var DOM = {};

  /* ------------------------------------------------------------------ 工具 */
  function byId(id) { return document.getElementById(id); }

  function q(sel, root) { return (root || document).querySelector(sel); }

  function qa(sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function clear(node) {
    if (!node) return;
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function append() {
    var node = arguments[0];
    for (var i = 1; i < arguments.length; i++) {
      if (arguments[i]) node.appendChild(arguments[i]);
    }
    return node;
  }

  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  function at(arr, i) {
    if (!arr || typeof i !== 'number') return null;
    var v = arr[i];
    return (typeof v === 'number' && isFinite(v)) ? v : null;
  }

  function num(v, digits) {
    if (!isNum(v)) return '—';
    var d = (digits === undefined) ? 2 : digits;
    var s = v.toFixed(d);
    if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
    return s;
  }

  function num2(v) { return isNum(v) ? v.toFixed(2) : '—'; }

  function int(v) {
    if (!isNum(v)) return '—';
    return String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function pct(v, digits) {
    if (!isNum(v)) return '—';
    var d = (digits === undefined) ? 1 : digits;
    return (v * 100).toFixed(d) + '%';
  }

  /* 分位：后端可能给 0~1，也可能给 0~100 */
  function pctl(v) {
    if (!isNum(v)) return '—';
    var x = (v <= 1 && v >= 0) ? v * 100 : v;
    return x.toFixed(1) + '%';
  }

  /* 带正负号的数值：正号 +、负号 −（双编码，不靠颜色单通道） */
  function signed(v, digits) {
    if (!isNum(v)) return '—';
    var d = (digits === undefined) ? 1 : digits;
    var s = v > 0 ? '+' : (v < 0 ? '−' : '');
    return s + Math.abs(v).toFixed(d);
  }

  function coverageCls(v) {
  if (!isNum(v)) return '';
  return v >= 0.95 ? '' : 'warn';
}

function signCls(v) {
    if (!isNum(v)) return 'na';
    return v > 0 ? 'pos' : (v < 0 ? 'neg' : 'zero');
  }

  function yi(v, digits) {
    if (!isNum(v)) return '—';
    return (v / 1e8).toFixed(digits === undefined ? 1 : digits);
  }

  function textOf(x) {
    if (x === null || x === undefined) return '';
    if (typeof x === 'string') return x;
    if (typeof x === 'number' || typeof x === 'boolean') return String(x);
    if (typeof x === 'object') {
      return String(x.text || x.note || x.label || x.message || x.reason || '');
    }
    return '';
  }

  function cssVar(name, fallback) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name);
    v = v ? v.trim() : '';
    return v || fallback;
  }

  function modeLabel(code) {
    if (!code) return '—';
    return MODE_LABELS[code] || String(code);
  }

  function statusLabel(code) {
    if (!code) return '—';
    return STATUS_LABELS[code] || String(code);
  }

  function dimLabel(key) {
    if (!key) return '维度';
    return DIM_LABELS[key] || String(key);
  }

  function fieldLabel(key) {
    return FIELD_LABELS[key] || String(key);
  }

  function toast(msg) {
    if (!DOM.toast) return;
    DOM.toast.textContent = msg;
    DOM.toast.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { DOM.toast.hidden = true; }, 2200);
  }

  /* ------------------------------------------------------------------ 数据加载 */
  function loadJson(url) {
    if (!DATA_CACHE[url]) DATA_CACHE[url] = fetchJson(url);
    return DATA_CACHE[url];
  }

  function fetchJson(url) {
    var abs;
    try { abs = new URL(url, location.href).href; } catch (e) { abs = url; }

    return fetch(url, { cache: 'no-store' }).then(function (res) {
      if (res.status === 404) {
        return { state: 'missing', url: url };
      }
      if (!res.ok) {
        return fallbackCache(abs, url, 'HTTP ' + res.status);
      }
      return res.json().then(function (json) {
        if (!json || typeof json !== 'object') {
          return { state: 'error', url: url, error: 'JSON 结构不是对象' };
        }
        return { state: 'ok', url: url, json: json };
      }, function (err) {
        return { state: 'error', url: url, error: 'JSON 解析失败：' + (err && err.message ? err.message : err) };
      });
    }).catch(function (err) {
      return fallbackCache(abs, url, (err && err.message) ? err.message : String(err));
    });
  }

  function fallbackCache(absUrl, url, reason) {
    if (!('caches' in window)) {
      return Promise.resolve({ state: 'error', url: url, error: reason });
    }
    return caches.match(absUrl).then(function (hit) {
      return hit || caches.match(url);
    }).then(function (hit) {
      if (!hit || !hit.ok) return { state: 'error', url: url, error: reason };
      return hit.json().then(function (json) {
        return { state: 'stale', url: url, json: json, error: reason };
      });
    }).catch(function () {
      return { state: 'error', url: url, error: reason };
    });
  }

  /* ------------------------------------------------------------------ 顶栏 / stale */
  function syncTopOffset() {
    if (!DOM.topwrap) return;
    var h = Math.round(DOM.topwrap.getBoundingClientRect().height);
    if (h > 0) document.documentElement.style.setProperty('--top-h', h + 'px');
  }

  function setStaleBanner(on, parts) {
    if (!DOM.staleBanner) return;
    DOM.staleBanner.hidden = !on;
    if (on) {
      var bits = [];
      if (parts && parts[0]) bits.push('时点 ' + parts[0]);
      if (parts && parts[1]) bits.push('生成于 ' + String(parts[1]).replace('T', ' '));
      if (parts && parts[2]) bits.push('状态 ' + statusLabel(parts[2]));
      DOM.staleDetail.textContent = bits.length ? '（' + bits.join(' · ') + '）' : '';
    } else {
      DOM.staleDetail.textContent = '';
    }
    syncTopOffset();
  }

  function applyMeta(meta, viaCache) {
    meta = meta || {};
    var asOf = meta.as_of || '—';
    var st = meta.status || 'unknown';

    if (DOM.tbAsOf) {
      DOM.tbAsOf.textContent = asOf;
      DOM.tbAsOf.title = meta.generated_at_sh ? ('生成于 ' + meta.generated_at_sh) : '';
    }
    if (DOM.tbMode) {
      DOM.tbMode.textContent = modeLabel(meta.quality_tier);
      DOM.tbMode.title = meta.quality_tier ? ('数据模式 ' + meta.quality_tier) : '未提供数据模式';
    }
    if (DOM.tbLight) DOM.tbLight.setAttribute('data-status', st);
    if (DOM.tbLightText) DOM.tbLightText.textContent = statusLabel(st);
    if (DOM.tbModel) {
      DOM.tbModel.textContent = meta.model_version || '—';
      DOM.tbModel.title = meta.model_version || '';
    }

    var stale = meta.stale === true || st === 'stale' || viaCache === true;
    setStaleBanner(stale, [asOf, meta.generated_at_sh, st]);
  }

  function metaLine(meta, extra) {
    meta = meta || {};
    var bits = [];
    if (meta.as_of) bits.push('时点 ' + meta.as_of);
    if (meta.generated_at_sh) bits.push('生成 ' + String(meta.generated_at_sh).replace('T', ' '));
    if (meta.model_version) bits.push('模型 ' + meta.model_version);
    if (meta.quality_tier) bits.push('模式 ' + modeLabel(meta.quality_tier) + '（' + meta.quality_tier + '）');
    bits.push('状态 ' + statusLabel(meta.status || 'unknown'));
    if (isNum(meta.confidence)) bits.push('置信度 ' + pct(meta.confidence, 0));
    if (Array.isArray(meta.sources) && meta.sources.length) bits.push('来源 ' + meta.sources.join(' / '));
    if (extra) bits.push(extra);
    return el('p', 'meta-line', bits.join(' · '));
  }

  /* ------------------------------------------------------------------ 通用块 */
  function emptyBox(title, sub) {
    var box = el('div', 'empty');
    box.appendChild(el('div', 'empty-title', title));
    if (sub) box.appendChild(el('div', 'empty-sub', sub));
    return box;
  }

  function notGenerated(url) {
    return emptyBox('该模块尚未生成',
      '后端尚未导出 ' + url + '。前端不做占位数据，也不臆造数值；数据生成后刷新即可看到。');
  }

  function errorBox(url, msg) {
    var box = el('div', 'notice danger');
    var inner = el('div');
    inner.appendChild(el('div', 'err-title', '读取失败'));
    inner.appendChild(el('div', 'err-sub', url + (msg ? ' · ' + msg : '')));
    inner.appendChild(el('div', 'err-sub', '已尝试回退浏览器缓存；缓存里也没有时会显示这块提示而不是白屏。'));
    box.appendChild(inner);
    return box;
  }

  function cacheNotice(reason) {
    var box = el('div', 'notice warn');
    box.appendChild(el('span', 'stale-icon', '!'));
    var inner = el('div');
    inner.appendChild(el('b', null, '当前展示的是浏览器缓存的上次快照'));
    inner.appendChild(el('div', 'err-sub', '原因：' + (reason || '网络请求失败')));
    box.appendChild(inner);
    return box;
  }

  function warningsNode(list, title) {
    if (!Array.isArray(list) || !list.length) return null;
    var box = el('div', 'notice warn');
    box.appendChild(el('span', 'stale-icon', '!'));
    var inner = el('div');
    inner.appendChild(el('b', null, (title || '警告') + '（' + list.length + '）'));
    var ul = el('ul', 'plain-list compact');
    list.forEach(function (w) {
      var t = textOf(w);
      if (t) ul.appendChild(el('li', null, t));
    });
    inner.appendChild(ul);
    box.appendChild(inner);
    return box;
  }

  function chipList(values, cls) {
    var wrap = el('div', 'taglist');
    (values || []).forEach(function (v) {
      var t = textOf(v);
      if (!t) return;
      wrap.appendChild(el('span', 'badge ' + (cls || ''), t));
    });
    return wrap;
  }

  function kpiGrid(items, extraCls) {
    var grid = el('div', 'kpi-grid ' + (extraCls || ''));
    items.forEach(function (it) {
      if (!it) return;
      var k = el('div', 'kpi');
      k.appendChild(el('div', 'kpi-k', it[0]));
      k.appendChild(el('div', 'kpi-v' + (it[2] ? ' ' + it[2] : ''), it[1]));
      if (it[3]) k.appendChild(el('div', 'kpi-h', it[3]));
      grid.appendChild(k);
    });
    return grid;
  }

  function kvRow(k, v, vCls) {
    var row = el('div', 'kv');
    row.appendChild(el('span', 'kv-k', k));
    row.appendChild(el('b', 'kv-v ' + (vCls || ''), v));
    return row;
  }

  function kvGrid(pairs) {
    var g = el('div', 'kv-grid');
    pairs.forEach(function (p) {
      if (!p) return;
      var row = el('div', 'kv');
      row.appendChild(el('span', 'kv-k', p[0]));
      row.appendChild(el('b', 'kv-v ' + (p[2] || ''), p[1]));
      g.appendChild(row);
    });
    return g;
  }

  function card(title, sub) {
    var c = el('div', 'card');
    var head = el('div', 'card-head');
    if (title) head.appendChild(el('h2', 'card-title', title));
    if (sub) head.appendChild(el('p', 'card-sub', sub));
    if (title || sub) c.appendChild(head);
    return c;
  }

  function block(title) {
    var b = el('div', 'block');
    if (title) b.appendChild(el('div', 'block-h', title));
    return b;
  }

  function bar(value, cls) {
    var b = el('div', 'bar');
    var fill = el('i', cls || '');
    var v = isNum(value) ? Math.max(0, Math.min(100, value)) : 0;
    fill.style.width = v + '%';
    b.appendChild(fill);
    return b;
  }

  /* 统一的“读文件 → 渲染”流程 */
  function renderResult(container, result, renderFn) {
    if (!container) return null;
    clear(container);

    if (result.state === 'ok' || result.state === 'stale') {
      if (result.state === 'stale') container.appendChild(cacheNotice(result.error));
      var json = result.json || {};
      var meta = json.meta || {};
      applyMeta(meta, result.state === 'stale');
      try {
        renderFn(json, container);
      } catch (err) {
        container.appendChild(errorBox(result.url, '渲染异常：' + (err && err.message ? err.message : err)));
        if (window.console) console.error('[pwa] render error', err);
      }
      return json;
    }

    if (result.state === 'missing') {
      container.appendChild(notGenerated(result.url));
      return null;
    }

    container.appendChild(errorBox(result.url, result.error));
    return null;
  }

  /* ------------------------------------------------------------------ 主题 */
  function initTheme() {
    var saved = null;
    try { saved = localStorage.getItem('qp.theme'); } catch (e) { /* 隐私模式 */ }
    STATE.theme = (saved === 'light' || saved === 'dark' || saved === 'auto') ? saved : 'auto';
    applyTheme(false);
    if (DOM.themeBtn) {
      DOM.themeBtn.addEventListener('click', function () {
        STATE.theme = STATE.theme === 'auto' ? 'dark' : (STATE.theme === 'dark' ? 'light' : 'auto');
        try { localStorage.setItem('qp.theme', STATE.theme); } catch (e) { /* 忽略 */ }
        applyTheme(true);
        toast('外观：' + THEME_LABELS[STATE.theme]);
      });
    }
  }

  function applyTheme(rebuildChart) {
    var root = document.documentElement;
    if (STATE.theme === 'auto') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', STATE.theme);

    if (DOM.themeBtn) {
      DOM.themeBtn.setAttribute('aria-label', '切换深浅色（当前：' + THEME_LABELS[STATE.theme] + '）');
      DOM.themeBtn.title = '切换深浅色（当前：' + THEME_LABELS[STATE.theme] + '）';
    }

    if (rebuildChart && STATE.chartData) {
      destroyChart();
      renderChart();
    }
  }

  /* ------------------------------------------------------------------ 顶栏按钮 / 路由 */
  function bindGlobal() {
    if (DOM.refreshBtn) {
      DOM.refreshBtn.addEventListener('click', function () {
        DATA_CACHE = {};
        for (var k in PAGE_READY) { if (Object.prototype.hasOwnProperty.call(PAGE_READY, k)) PAGE_READY[k] = false; }
        STATE.chartData = null;
        destroyChart();
        ensurePage(STATE.page, true);
        toast('正在重新读取本地数据…');
      });
    }

    qa('.tab').forEach(function (btn) {
      btn.addEventListener('click', function () { switchPage(btn.dataset.target); });
    });

    window.addEventListener('hashchange', function () {
      var target = String(location.hash || '').replace('#', '');
      if (PAGE_READY.hasOwnProperty(target) && target !== STATE.page) switchPage(target);
    });

    var resizeTimer = null;
    window.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        if (STATE.chart) STATE.chart.resize();
        syncTopOffset();
      }, 120);
    });
    window.addEventListener('orientationchange', function () {
      setTimeout(function () { if (STATE.chart) STATE.chart.resize(); syncTopOffset(); }, 220);
    });
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && STATE.chart) STATE.chart.resize();
    });

    window.addEventListener('online', function () { toast('网络已恢复'); });
    window.addEventListener('offline', function () { toast('已离线：将回退到缓存快照'); });

    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      window.addEventListener('load', function () {
        navigator.serviceWorker.register('service-worker.js', { updateViaCache: 'none' })
          .catch(function (err) {
            if (window.console) console.warn('[pwa] Service Worker 注册失败', err);
          });
      });
    }
  }

  function switchPage(page) {
    if (!Object.prototype.hasOwnProperty.call(PAGE_READY, page)) page = 'overview';
    STATE.page = page;

    qa('.page').forEach(function (sec) { sec.hidden = sec.dataset.page !== page; });
    qa('.tab').forEach(function (btn) {
      btn.setAttribute('aria-selected', String(btn.dataset.target === page));
    });

    try { history.replaceState(null, '', '#' + page); } catch (e) { location.hash = page; }

    ensurePage(page, false);
    window.scrollTo(0, 0);
    syncTopOffset();

    if (page === 'overview') {
      setTimeout(function () {
        if (STATE.chart) STATE.chart.resize();
        else if (STATE.chartData) renderChart();   /* 主题切换等场景下实例已销毁，重建 */
      }, 40);
    }
  }

  function ensurePage(page, force) {
    if (PAGE_READY[page] && !force) return;
    PAGE_READY[page] = true;
    if (page === 'overview') initOverview();
    else if (page === 'sectors') initSectors();
    else if (page === 'candidates') initCandidates();
    else if (page === 'limit') initLimit();
    else if (page === 'research') initResearch();
    else if (page === 'system') initSystem();
  }

  /* ==================================================================
   * 1. 市场总览
   * ================================================================== */

  function initOverview() {
    /* 指数 / 区间切换按钮先建好：即使今天没有 breadth 文件，控件也在 */
    buildIndexChips(null);
    buildRangeChips();

    loadJson(FILES.market).then(function (result) {
      renderResult(byId('ovScore'), result, function (json) {
        renderScoreCard(json);
        renderContributionCard(json);
      });
      renderResult(byId('ovMetrics'), result, function (json) {
        renderOverviewMetrics(json);
      });
    });

    loadJson(FILES.breadth).then(function (result) {
      if (result.state === 'ok' || result.state === 'stale') {
        applyMeta(result.json.meta || {}, result.state === 'stale');
        renderBreadthSummary(result.json, result);
        buildTriChart(result.json);
      } else if (result.state === 'missing') {
        showChartMessage('三联图', '该模块尚未生成',
          '后端尚未导出 ' + FILES.breadth + '；三联图需要 trade_dates / kline / amount / breadth 四段等长序列。');
        renderResult(byId('ovBreadth'), result, function () {});
      } else {
        showChartMessage('三联图', '数据读取失败', (result.error || '') + ' · 已尝试回退浏览器缓存');
        renderResult(byId('ovBreadth'), result, function () {});
      }
    });
  }

  /* ---------------- 分数卡（总分 → 五分项 → 底层指标） ---------------- */

  function renderScoreCard(json) {
    var slot = byId('ovScore');
    if (!slot) return;
    var d = json.data || {};
    var meta = json.meta || {};

    var cardEl = el('div', 'card score-card');

    var head = el('button', 'score-head');
    head.type = 'button';
    head.setAttribute('aria-expanded', 'false');
    head.setAttribute('aria-controls', 'scoreL1');

    var left = el('div', 'score-left');

    var numWrap = el('div', 'score-num-wrap');
    numWrap.appendChild(el('div', 'score-num', isNum(d.raw_score) ? d.raw_score.toFixed(1) : '—'));
    numWrap.appendChild(el('div', 'score-num-cap', '情绪总分'));
    left.appendChild(numWrap);

    var mid = el('div', 'score-mid');
    var labelKey = String(d.label || 'neutral').replace(/[^a-z_]/gi, '') || 'neutral';
    mid.appendChild(el('span', 'badge label-' + labelKey, d.label_zh || String(d.label || '—')));
    mid.appendChild(el('div', 'score-line',
      '平滑分 ' + (isNum(d.smooth_score) ? d.smooth_score.toFixed(1) : '—') +
      ' · 置信度 ' + (isNum(meta.confidence) ? pct(meta.confidence, 0) : '—')
    ));
    mid.appendChild(el('div', 'score-line dim', '点开看五分项，再点看原始值/分位/权重/贡献分'));
    left.appendChild(mid);

    head.appendChild(left);
    head.appendChild(el('div', 'score-toggle', '展开五分项 ▾'));
    cardEl.appendChild(head);

    var l1 = el('div', 'score-l1');
    l1.id = 'scoreL1';
    l1.hidden = true;

    var comps = d.components || {};
    var keys = COMPONENT_ORDER.filter(function (k) { return comps[k] !== undefined; });
    Object.keys(comps).forEach(function (k) {
      if (keys.indexOf(k) < 0) keys.push(k);
    });

    if (!keys.length) {
      l1.appendChild(el('p', 'empty-line', '未提供 components，无法展开五分项。'));
    } else {
      keys.forEach(function (key) {
        l1.appendChild(buildComponentRow(key, comps[key], d, meta));
      });
    }

    var missing = Array.isArray(d.missing_indicators) ? d.missing_indicators
      : (Array.isArray(meta.missing_indicators) ? meta.missing_indicators : []);
    if (missing.length) {
      var mb = block('缺失指标（不当作 0 分参与计算）');
      mb.appendChild(chipList(missing, 'warn'));
      l1.appendChild(mb);
    }

    l1.appendChild(metaLine(meta, '解释层：contribution = (pctl − 0.5) × 2 × w × W × 100'));

    cardEl.appendChild(l1);
    slot.appendChild(cardEl);

    head.addEventListener('click', function () {
      var open = l1.hidden;
      l1.hidden = !open;
      head.setAttribute('aria-expanded', String(open));
      var t = q('.score-toggle', head);
      if (t) t.textContent = open ? '收起五分项 ▴' : '展开五分项 ▾';
    });
  }

  function buildComponentRow(key, comp, d, meta) {
    comp = comp || {};
    var row = el('div', 'comp');

    var btn = el('button', 'comp-head');
    btn.type = 'button';
    btn.setAttribute('aria-expanded', 'false');

    btn.appendChild(el('span', 'comp-name', COMPONENT_LABELS[key] || String(key)));
    btn.appendChild(el('b', 'comp-score', isNum(comp.score) ? comp.score.toFixed(1) : '—'));
    btn.appendChild(el('span', 'comp-w', isNum(comp.weight) ? ('权重 ' + pct(comp.weight, 1)) : '权重 —'));
    btn.appendChild(el('span', 'comp-avail' + (comp.available === false ? ' off' : ''),
      comp.available === false ? '不可用' : '可用'));

    row.appendChild(btn);
    row.appendChild(bar(comp.score));

    var panel = el('div', 'comp-panel');
    panel.hidden = true;
    buildIndicatorList(panel, key, d, meta);
    row.appendChild(panel);

    btn.addEventListener('click', function () {
      var open = panel.hidden;
      panel.hidden = !open;
      btn.setAttribute('aria-expanded', String(open));
    });

    return row;
  }

  function componentOf(item) {
    var c = item && (item.component || item.component_id || item.component_name || item.group);
    if (!c) return null;
    var hit = null;
    Object.keys(COMPONENT_LABELS).forEach(function (k) {
      if (COMPONENT_LABELS[k] === c) hit = k;
    });
    return hit || c;
  }

  function buildIndicatorList(panel, compKey, d, meta) {
    var all = Array.isArray(d.contributions) ? d.contributions : [];
    if (!all.length) {
      panel.appendChild(el('p', 'empty-line', '未提供 contributions：该分数的底层指标明细缺失，不能编造。'));
      return;
    }

    var grouped = all.some(function (it) { return !!componentOf(it); });
    var mine = all.filter(function (it) { return componentOf(it) === compKey; });
    var degradedToList = false;

    if (!mine.length) {
      if (grouped) {
        panel.appendChild(el('p', 'empty-line', '该分项暂无底层指标明细。'));
        return;
      }
      mine = all;
      degradedToList = true;
    }

    if (degradedToList) {
      panel.appendChild(el('p', 'empty-line', '后端未提供指标→分项归属，此处列出全部底层指标（' + all.length + ' 项）。'));
    }

    mine.forEach(function (it) {
      var box = el('div', 'ind');
      box.appendChild(el('div', 'ind-name', it.label || it.indicator || '未命名指标'));

      var grid = el('div', 'ind-kv');
      grid.appendChild(kvRow('原始值', rawValue(it.value)));
      grid.appendChild(kvRow('分位', pctl(it.pctl)));
      grid.appendChild(kvRow('权重', isNum(it.weight) ? pct(it.weight, 2) : '—'));

      var contribRow = el('div', 'kv');
      contribRow.appendChild(el('span', 'kv-k', '贡献分'));
      contribRow.appendChild(el('b', 'kv-v ' + signCls(it.contribution),
        isNum(it.contribution) ? signed(it.contribution, 1) + ' 分' : '—'));
      grid.appendChild(contribRow);

      grid.appendChild(kvRow('来源', it.source || '—'));
      grid.appendChild(kvRow('更新时间', it.updated_at || meta.generated_at_sh || '—'));
      box.appendChild(grid);
      panel.appendChild(box);
    });
  }

  function rawValue(v) {
    if (v === null || v === undefined) return '—';
    if (typeof v === 'number') {
      if (!isFinite(v)) return '—';
      if (Math.abs(v) >= 1000) return int(v);
      return String(Math.round(v * 10000) / 10000);
    }
    if (typeof v === 'boolean') return v ? '是' : '否';
    return String(v);
  }

  /* ---------------- 贡献前三 ---------------- */

  function renderContributionCard(json) {
    var slot = byId('ovContrib');
    if (!slot) return;
    var d = json.data || {};
    var meta = json.meta || {};
    var pos = Array.isArray(d.top_positive) ? d.top_positive : [];
    var neg = Array.isArray(d.top_negative) ? d.top_negative : [];
    if (!pos.length && !neg.length) return;

    var c = card('拉动项与拖累项', '贡献分带正负号与颜色双编码；加总应等于总分 −50。');

    if (pos.length) {
      var pb = block('正贡献前三');
      pb.appendChild(contribList(pos, 'pos'));
      c.appendChild(pb);
    }
    if (neg.length) {
      var nb = block('负贡献前三');
      nb.appendChild(contribList(neg, 'neg'));
      c.appendChild(nb);
    }
    c.appendChild(metaLine(meta));
    slot.appendChild(c);
  }

  function contribList(items, cls) {
    var grid = el('div', 'kv-grid');
    items.forEach(function (it) {
      var row = el('div', 'kv');
      var left = el('span', 'kv-k', it.label || it.indicator || '—');
      if (it.component) left.textContent += ' · ' + (COMPONENT_LABELS[it.component] || it.component);
      row.appendChild(left);
      row.appendChild(el('b', 'kv-v ' + cls,
        isNum(it.contribution) ? signed(it.contribution, 1) + ' 分' : '—'));
      grid.appendChild(row);
    });
    return grid;
  }

  /* ---------------- 总览指标 ---------------- */

  function renderOverviewMetrics(json) {
    var slot = byId('ovMetrics');
    if (!slot) return;
    var d = json.data || {};
    var meta = json.meta || {};

    /* 涨跌分布 */
    var b = d.breadth || {};
    var scopeLabel = b.universe_scope === 'full_market' ? '全市场' : '抽样池';
  var scopeNote = b.universe_scope === 'full_market'
    ? '净上涨 = 上涨 − 下跌；停牌/无成交计入「排除」，不参与涨跌统计。'
    : '当前池覆盖 ' + (isNum(b.market_coverage) ? pct(b.market_coverage) : '未知') +
      ' 的沪深 A 股（参考池 ' + (int(b.reference_universe) || '—') + ' 只），不是全市场：净上涨仅为该池口径。';
  var c1 = card('涨跌分布 · ' + scopeLabel, scopeNote);
c1.appendChild(kpiGrid([
      ['上涨', int(b.up), 'pos'],
      ['下跌', int(b.down), 'neg'],
      ['平盘', int(b.flat)],
      ['排除', int(b.excluded)],
      ['池内标的', int(b.universe)],
['全市场覆盖率', isNum(b.market_coverage) ? pct(b.market_coverage) : '—', coverageCls(b.market_coverage)],
    ['参考池', int(b.reference_universe) || '—']
      ['净上涨', isNum(b.net) ? signed(b.net, 0) : '—', signCls(b.net)]
    ]));
    var sub1 = el('div', 'kv-grid');
    sub1.appendChild(kvRow('上涨占比', pct(b.up_ratio)));
    sub1.appendChild(kvRow('覆盖率', pct(b.coverage)));
    var sub1Wrap = block('比例');
    sub1Wrap.appendChild(sub1);
    c1.appendChild(sub1Wrap);
    c1.appendChild(metaLine(meta));
    slot.appendChild(c1);

    /* 涨停 */
    var l = d.limit || {};
    var c2 = card('涨停生态（总览）', '封板率 = 封死数 / 触板数；与炸板率互补，不重复加权。');
    c2.appendChild(kpiGrid([
      ['涨停', int(l.limit_up), 'pos'],
      ['触板', int(l.touched)],
      ['炸板', int(l.broken), 'neg'],
      ['跌停', int(l.limit_down), 'neg'],
      ['封板率', pct(l.seal_rate)]
    ], 'g3'));
    c2.appendChild(metaLine(meta));
    slot.appendChild(c2);

    /* 成交额 */
    var a = d.amount || {};
    var c3 = card(a.is_estimated ? '成交额（含估算）' : '成交额',
  a.is_estimated
    ? '最新一日为交易所成交额（新浪快照）；历史区间腾讯日线无成交额字段，用「成交量 × 收盘价」估算，不等于交易所成交额。vs MA 亦为同口径。'
    : '真实交易所成交额。vs_ma5 / vs_ma20 为相对 5 日、20 日均量的倍数。');
    c3.appendChild(kpiGrid([
      ['成交额' + (a.is_estimated ? '（估算）' : ''), isNum(a.total_yuan) ? yi(a.total_yuan, 0) : '—', 'sm', '亿元'],
      ['vs MA5', isNum(a.vs_ma5) ? a.vs_ma5.toFixed(2) + '×' : '—'],
      ['vs MA20', isNum(a.vs_ma20) ? a.vs_ma20.toFixed(2) + '×' : '—']
    ], 'g3'));
    c3.appendChild(metaLine(meta));
    slot.appendChild(c3);

    /* 期权 PCR */
  var pcr = d.pcr || {};
  if (pcr.status === 'ok' || pcr.status === 'partial') {
    var cp = card('期权 PCR', 'volume_pcr = Put成交量 / Call成交量（上交所官方日统计）。PCR 高表示 Put 更活跃，不等于看空，需结合历史分位。');
    cp.appendChild(kpiGrid([
      ['综合 PCR', isNum(pcr.weighted_pcr) ? pcr.weighted_pcr.toFixed(2) : '—'],
      ['历史分位', isNum(pcr.pcr_pctl) ? pct(pcr.pcr_pctl) : (pcr.pctl_low_confidence ? '低置信' : '—')],
      ['历史天数', int(pcr.history_days) || 0],
      ['标的数', Array.isArray(pcr.by_underlying) ? pcr.by_underlying.length : 0]
    ], 'g4'));
    var bt = el('div', 'kv-grid');
    (pcr.by_underlying || []).forEach(function (u) {
      bt.appendChild(kvRow(u.underlying_name + '（' + u.underlying_code + '）',
        isNum(u.volume_pcr) ? u.volume_pcr.toFixed(3) : 'null（Call 成交量为 0）'));
    });
    if (bt.childNodes.length) cp.appendChild(bt);
    cp.appendChild(metaLine({
      sources: [pcr.source || ''],
      warnings: pcr.pctl_low_confidence ? ['历史不足 60 日，分位为低置信'] : []
    }));
    slot.appendChild(cp);
  } else if (pcr.status === 'unavailable') {
    var cu = card('期权 PCR', '当前不可用：' + (pcr.reason || '未知原因'));
    cu.appendChild(kvRow('公式', pcr.formula || 'volume_pcr = put_volume / call_volume'));
    slot.appendChild(cu);
  }

  /* 风险偏好 */
  var ra = d.risk_appetite || {};
  if (ra.status === 'ok') {
    var cr = card('风险偏好', '分组全部 shift(1) 防未来函数：用 t-1 及之前的数据分组，t 日收益评价。');
    cr.appendChild(kpiGrid([
      ['小盘 vs 大盘', isNum(ra.smallcap_vs_large) ? (ra.smallcap_vs_large * 100).toFixed(2) + '%' : '—'],
      ['成长 vs 价值', isNum(ra.growth_vs_value) ? (ra.growth_vs_value * 100).toFixed(2) + '%' : '—'],
      ['高波动 vs 低波动', isNum(ra.highvol_vs_lowvol) ? (ra.highvol_vs_lowvol * 100).toFixed(2) + '%' : '—'],
      ['强势延续', isNum(ra.strong_stock_continuation) ? (ra.strong_stock_continuation * 100).toFixed(2) + '%' : '—']
    ], 'g4'));
    var rk = el('div', 'kv-grid');
    rk.appendChild(kvRow('小盘/大盘代理', ra.proxies ? ra.proxies.smallcap_vs_large : '—'));
    rk.appendChild(kvRow('成长/价值代理', ra.proxies ? ra.proxies.growth_vs_value : '—'));
    rk.appendChild(kvRow('高/低波动样本', ra.samples ? String(ra.samples.highvol_pairs) : '—'));
    rk.appendChild(kvRow('强/弱延续样本', ra.samples ? String(ra.samples.strong_pairs) : '—'));
    cr.appendChild(rk);
    slot.appendChild(cr);
  }

  /* 指数趋势 */
    if (Array.isArray(d.index_trend) && d.index_trend.length) {
      var c4 = card('宽基趋势', 'ma20_dev / ma60_dev 为相对均线偏离率。');
      var g4 = el('div', 'kv-grid');
      d.index_trend.forEach(function (ix) {
        var row = el('div', 'kv');
        var hit = INDEX_LIST.filter(function (x) { return x.code === ix.ts_code; })[0];
        var headText = (ix.ts_code || '—') + (hit ? ' ' + hit.name : '');
        row.appendChild(el('span', 'kv-k', headText));
        row.appendChild(el('b', 'kv-v',
          num2(ix.close) + ' · MA20 ' + (isNum(ix.ma20_dev) ? pct(ix.ma20_dev, 2) : '—') +
          ' · MA60 ' + (isNum(ix.ma60_dev) ? pct(ix.ma60_dev, 2) : '—')));
        g4.appendChild(row);
      });
      c4.appendChild(g4);
      c4.appendChild(metaLine(meta));
      slot.appendChild(c4);
    }

    /* PCR */
    var p = d.pcr;
    if (p) {
      var c5 = card('Put/Call Ratio', '期权接口未接入时显示不可用，不用 0 或默认值代替。');
      c5.appendChild(kpiGrid([
        ['PCR', isNum(p.value) ? num2(p.value) : '—', 'sm'],
        ['状态', p.status || '—'],
        ['说明', p.reason || '—', 'sm']
      ], 'g3'));
      c5.appendChild(metaLine(meta));
      slot.appendChild(c5);
    }

    var wn = warningsNode(meta.warnings, '数据警告');
    if (wn) slot.appendChild(wn);
    var mn = warningsNode(d.missing_indicators, '缺失指标');
    if (mn) slot.appendChild(mn);
  }

  /* ---------------- 广度序列摘要 ---------------- */

  function renderBreadthSummary(json, result) {
    var slot = byId('ovBreadth');
    if (!slot) return;
    clear(slot);
    var d = json.data || {};
    var meta = json.meta || {};
    var dates = Array.isArray(d.trade_dates) ? d.trade_dates : [];
    if (!dates.length) {
      slot.appendChild(emptyBox('序列为空', 'market_breadth.json 里没有 trade_dates，三联图无法绘制。'));
      return;
    }

    var lastIdx = -1;
    for (var i = dates.length - 1; i >= 0; i--) {
      if (at(d.breadth && d.breadth.net, i) !== null) { lastIdx = i; break; }
    }

    var c = card('广度序列', '数组与 trade_dates 等长对齐；缺数据的交易日保留 null，不删日期。');
    c.appendChild(kpiGrid([
      ['交易日数', int(dates.length), 'sm'],
      ['区间', dates[0] + ' → ' + dates[dates.length - 1], 'sm'],
      ['最新净上涨', lastIdx >= 0 ? signed(at(d.breadth.net, lastIdx), 0) : '—',
        lastIdx >= 0 ? signCls(at(d.breadth.net, lastIdx)) : 'na'],
      ['最新覆盖率', lastIdx >= 0 ? pct(at(d.breadth.coverage, lastIdx)) : '—']
    ]));

    if (Array.isArray(d.warnings) && d.warnings.length) {
      var w = warningsNode(d.warnings, '序列警告');
      if (w) c.appendChild(w);
    }
    c.appendChild(metaLine(meta));
    slot.appendChild(c);
  }

  /* ==================================================================
   * 三联图（ECharts，本地 vendor/echarts.min.js）
   * ================================================================== */

  function showChartMessage(title, head, sub) {
    var box = byId('triChart');
    if (!box) return;
    destroyChart();
    STATE.chartMsg = true;
    clear(box);
    var msg = el('div', 'chart-msg');
    msg.appendChild(el('b', null, head));
    msg.appendChild(el('span', null, sub));
    box.appendChild(msg);
    if (title) box.setAttribute('aria-label', title + '：' + head);
  }

  function destroyChart() {
    if (STATE.chartObserver) {
      try { STATE.chartObserver.disconnect(); } catch (e) { /* 忽略 */ }
      STATE.chartObserver = null;
    }
    if (STATE.chart) {
      try { STATE.chart.dispose(); } catch (e) { /* 忽略 */ }
      STATE.chart = null;
    }
  }

  function buildTriChart(json) {
    var d = json.data || {};
    var dates = Array.isArray(d.trade_dates) ? d.trade_dates : [];
    if (!dates.length) {
      showChartMessage('三联图', '序列缺失', 'trade_dates 为空，无法对齐三个面板。');
      return;
    }
    if (typeof echarts === 'undefined') {
      showChartMessage('三联图', '本地图表库未加载',
        '找不到 vendor/echarts.min.js：请确认该文件已随站点一起部署（前端不引用任何 CDN）。');
      return;
    }
    STATE.chartData = json;
    renderChart();
    buildIndexChips(d.indices);
    buildRangeChips();
    updateTriNote();
  }

  function buildIndexChips(indices) {
    var wrap = byId('idxChips');
    if (!wrap) return;
    var names = {};
    (indices || []).forEach(function (ix) {
      if (ix && ix.ts_code) names[ix.ts_code] = ix.name;
    });
    clear(wrap);
    INDEX_LIST.forEach(function (ix) {
      var b = el('button', 'chip', names[ix.code] || ix.name);
      b.type = 'button';
      b.dataset.code = ix.code;
      b.setAttribute('aria-pressed', String(STATE.index === ix.code));
      b.addEventListener('click', function () {
        if (STATE.index === ix.code) return;
        STATE.index = ix.code;
        qa('.chip', wrap).forEach(function (x) {
          x.setAttribute('aria-pressed', String(x.dataset.code === ix.code));
        });
        if (STATE.chart) {
          STATE.chart.setOption({ series: [{ id: 'kline', data: candleData(STATE.chartData, ix.code) }] });
        }
        updateTriNote();
      });
      wrap.appendChild(b);
    });
  }

  function buildRangeChips() {
    var wrap = byId('rangeChips');
    if (!wrap) return;
    clear(wrap);
    RANGES.forEach(function (n) {
      var b = el('button', 'chip', n + ' 日');
      b.type = 'button';
      b.dataset.range = String(n);
      b.setAttribute('aria-pressed', String(STATE.range === n));
      b.addEventListener('click', function () {
        STATE.range = n;
        qa('.chip', wrap).forEach(function (x) {
          x.setAttribute('aria-pressed', String(x.dataset.range === String(n)));
        });
        applyRange(n);
        updateTriNote();
      });
      wrap.appendChild(b);
    });
  }

  function zoomWindow(total, n) {
    if (!total) return { start: 0, end: 100 };
    var vis = Math.min(n, total);
    var start = total > vis ? (1 - vis / total) * 100 : 0;
    return { start: start, end: 100 };
  }

  function applyRange(n) {
    var ch = STATE.chart;
    var data = STATE.chartData && STATE.chartData.data;
    if (!ch || !data) return;
    var total = (data.trade_dates || []).length;
    var w = zoomWindow(total, n);
    ch.dispatchAction({ type: 'dataZoom', start: w.start, end: w.end });
  }

  function candleData(json, code) {
    var d = (json && json.data) || {};
    var dates = Array.isArray(d.trade_dates) ? d.trade_dates : [];
    var k = (d.kline || {})[code] || {};
    var out = [];
    for (var i = 0; i < dates.length; i++) {
      var o = at(k.open, i), c = at(k.close, i), l = at(k.low, i), h = at(k.high, i);
      if (o === null || c === null || l === null || h === null) {
        out.push(['-', '-', '-', '-']);   /* ECharts 里 '-' 表示空，占位不删日期 */
      } else {
        out.push([o, c, l, h]);
      }
    }
    return out;
  }

  function amountData(json) {
    var d = (json && json.data) || {};
    var dates = Array.isArray(d.trade_dates) ? d.trade_dates : [];
    var arr = (d.amount && d.amount.total_yuan) || [];
    var out = [];
    for (var i = 0; i < dates.length; i++) {
      var v = at(arr, i);
      out.push(v === null ? null : v / 1e8);   /* 亿元 */
    }
    return out;
  }

  function netData(json) {
    var d = (json && json.data) || {};
    var dates = Array.isArray(d.trade_dates) ? d.trade_dates : [];
    var arr = (d.breadth && d.breadth.net) || [];
    var up = cssVar('--up', '#d02b2b');
    var down = cssVar('--down', '#0d8f5c');
    var flat = cssVar('--flat', '#8b95a3');
    var out = [];
    for (var i = 0; i < dates.length; i++) {
      var v = at(arr, i);
      if (v === null) { out.push(null); continue; }
      var color = v > 0 ? up : (v < 0 ? down : flat);
      out.push({ value: v, itemStyle: { color: color } });
    }
    return out;
  }

  function chartTheme() {
    return {
      text: cssVar('--text', '#111820'),
      text2: cssVar('--text-2', '#55616f'),
      text3: cssVar('--text-3', '#8b95a3'),
      line: cssVar('--line', '#dde3ea'),
      lineStrong: cssVar('--line-strong', '#c8d1dd'),
      surface: cssVar('--surface', '#ffffff'),
      up: cssVar('--up', '#d02b2b'),
      down: cssVar('--down', '#0d8f5c'),
      flat: cssVar('--flat', '#8b95a3'),
      accent: cssVar('--accent', '#2563eb')
    };
  }

  function renderChart() {
    var box = byId('triChart');
    if (!box || !STATE.chartData) return;
    if (typeof echarts === 'undefined') return;

    if (!box.offsetWidth) {
      /* 页面隐藏或被折叠：等布局稳定再画 */
      STATE.chartMsg = true;
      setTimeout(function () {
        if (byId('triChart') === box && box.offsetWidth) { STATE.chartMsg = false; renderChart(); }
      }, 120);
      return;
    }

    STATE.chartMsg = false;
    destroyChart();
    clear(box);

    var chart = echarts.init(box, null, { renderer: 'canvas' });
    STATE.chart = chart;
    chart.setOption(buildChartOption(STATE.chartData), true);

    /* init 之后监听 resize（window resize 在 bindGlobal 里另有一道） */
    if (typeof ResizeObserver !== 'undefined') {
      try {
        STATE.chartObserver = new ResizeObserver(function () {
          if (STATE.chart) STATE.chart.resize();
        });
        STATE.chartObserver.observe(box);
      } catch (e) { /* 忽略 */ }
    }
  }

  function buildChartOption(json) {
    var d = json.data || {};
    var dates = Array.isArray(d.trade_dates) ? d.trade_dates : [];
    var n = dates.length;
    var w = zoomWindow(n, STATE.range);
    var t = chartTheme();

    var idxName = (INDEX_LIST.filter(function (x) { return x.code === STATE.index; })[0] || {}).name || STATE.index;

    var axisCommon = {
      type: 'category',
      data: dates,
      boundaryGap: true,
      axisLine: { lineStyle: { color: t.lineStrong } },
      axisTick: { show: false },
      axisLabel: {
        color: t.text3,
        fontSize: 9,
        hideOverlap: true
      },
      splitLine: { show: false },
      axisPointer: { label: { show: true, fontSize: 10 } }
    };

    return {
      animation: false,
      backgroundColor: 'transparent',
      textStyle: { color: t.text2, fontSize: 11 },
      title: [
        { text: idxName + ' 日K', left: 4, top: 4, textStyle: { fontSize: 11, fontWeight: 600, color: t.text2 } },
        { text: '成交额（亿元' + (d.amount && d.amount.any_estimated ? '，历史含估算' : '') + '）', left: 4, top: '37%', textStyle: { fontSize: 11, fontWeight: 600, color: t.text2 } },
        { text: '净上涨家数', left: 4, top: '52.5%', textStyle: { fontSize: 11, fontWeight: 600, color: t.text2 } }
      ],
      grid: [
        { left: 52, right: 12, top: 30, height: '29%' },
        { left: 52, right: 12, top: '40%', height: '12%' },
        { left: 52, right: 12, top: '56%', height: '20%' }
      ],
      axisPointer: {
        link: [{ xAxisIndex: 'all' }],
        label: { backgroundColor: t.text2, color: t.surface, fontSize: 10 },
        lineStyle: { color: t.lineStrong, width: 1, type: 'dashed' }
      },
      tooltip: {
        trigger: 'axis',
        confine: true,
        transitionDuration: 0,
        backgroundColor: t.surface,
        borderColor: t.line,
        borderWidth: 1,
        padding: [8, 10],
        textStyle: { color: t.text, fontSize: 12 },
        extraCssText: 'box-shadow: 0 8px 24px rgba(0,0,0,.18); border-radius: 10px;',
        axisPointer: { type: 'cross', crossStyle: { color: t.lineStrong } },
        formatter: function (params) {
          var idx = 0;
          for (var i = 0; i < (params || []).length; i++) {
            if (typeof params[i].dataIndex === 'number') { idx = params[i].dataIndex; break; }
          }
          return tooltipHtml(idx);
        }
      },
      dataZoom: [
        { type: 'inside', xAxisIndex: [0, 1, 2], start: w.start, end: w.end, minValueSpan: 5 },
        {
          type: 'slider', xAxisIndex: [0, 1, 2], start: w.start, end: w.end,
          bottom: '8%', height: 18, borderColor: t.line,
          backgroundColor: 'transparent',
          fillerColor: 'rgba(120,140,170,0.16)',
          handleStyle: { color: t.accent },
          moveHandleStyle: { color: t.accent },
          dataBackground: { lineStyle: { color: t.lineStrong }, areaStyle: { color: t.line } },
          selectedDataBackground: { lineStyle: { color: t.accent }, areaStyle: { color: 'rgba(120,140,170,0.18)' } },
          textStyle: { color: t.text3, fontSize: 9 }
        }
      ],
      visualMap: {
        show: false,
        type: 'piecewise',
        seriesIndex: 2,
        dimension: 0,
        pieces: [
          { gt: 0, color: t.up },
          { lt: 0, color: t.down },
          { value: 0, color: t.flat }
        ]
      },
      xAxis: [
        Object.assign({}, axisCommon, {
          gridIndex: 0,
          axisLabel: { show: false },
          axisPointer: { label: { show: false } }
        }),
        Object.assign({}, axisCommon, {
          gridIndex: 1,
          axisLabel: { show: false },
          axisPointer: { label: { show: false } }
        }),
        Object.assign({}, axisCommon, {
          gridIndex: 2,
          axisLabel: {
            color: t.text3, fontSize: 9, hideOverlap: true,
            formatter: function (v) { return String(v).slice(5); }
          }
        })
      ],
      yAxis: [
        {
          gridIndex: 0,
          scale: true,
          splitNumber: 3,
          axisLine: { show: false },
          axisTick: { show: false },
          axisLabel: { color: t.text3, fontSize: 9, formatter: function (v) { return v.toFixed(0); } },
          splitLine: { lineStyle: { color: t.line, type: 'dashed' } }
        },
        {
          gridIndex: 1,
          scale: true,
          splitNumber: 2,
          axisLine: { show: false },
          axisTick: { show: false },
          axisLabel: { color: t.text3, fontSize: 9, formatter: function (v) { return v >= 1000 ? (v / 1000).toFixed(1) + 'k' : v.toFixed(0); } },
          splitLine: { lineStyle: { color: t.line, type: 'dashed' } }
        },
        {
          gridIndex: 2,
          scale: false,
          splitNumber: 3,
          axisLine: { show: false },
          axisTick: { show: false },
          /* 正负号标注：不能只靠颜色区分 */
          axisLabel: {
            color: t.text3, fontSize: 9,
            formatter: function (v) { return (v > 0 ? '+' : '') + v; }
          },
          splitLine: { lineStyle: { color: t.line, type: 'dashed' } }
        }
      ],
      series: [
        {
          id: 'kline',
          name: '指数日K',
          type: 'candlestick',
          xAxisIndex: 0,
          yAxisIndex: 0,
          data: candleData(json, STATE.index),
          itemStyle: {
            color: t.up, color0: t.down,
            borderColor: t.up, borderColor0: t.down, borderWidth: 1
          },
          large: true,
          largeThreshold: 400
        },
        {
          id: 'amount',
          name: '成交额（亿元' + (d.amount && d.amount.any_estimated ? '，历史含估算' : '') + '）',
          type: 'bar',
          xAxisIndex: 1,
          yAxisIndex: 1,
          data: amountData(json),
          barWidth: '62%',
          large: true,
          largeThreshold: 400,
          itemStyle: { color: t.accent, opacity: 0.62, borderRadius: [2, 2, 0, 0] }
        },
        {
          id: 'net',
          name: '净上涨家数',
          type: 'line',
          xAxisIndex: 2,
          yAxisIndex: 2,
          data: netData(json),
          showSymbol: true,
          symbol: 'circle',
          symbolSize: n > 150 ? 2.6 : 3.6,
          connectNulls: false,
          smooth: false,
          lineStyle: { width: 1.4, color: t.flat, opacity: 0.85 },
          itemStyle: { color: t.flat },
          emphasis: { disabled: true },
          markLine: {
            silent: true,
            symbol: 'none',
            animation: false,
            lineStyle: { color: t.lineStrong, width: 1.2, type: 'dashed' },
            label: {
              show: true, position: 'insideStartTop', fontSize: 9,
              color: t.text3, formatter: '0 轴'
            },
            data: [{ yAxis: 0 }]
          }
        }
      ]
    };
  }

  function tooltipHtml(idx) {
    var json = STATE.chartData;
    var d = (json && json.data) || {};
    var dates = Array.isArray(d.trade_dates) ? d.trade_dates : [];
    var meta = (json && json.meta) || {};
    var date = dates[idx] || '—';
    var code = STATE.index;
    var ixName = (INDEX_LIST.filter(function (x) { return x.code === code; })[0] || {}).name || code;
    var k = (d.kline || {})[code] || {};
    var b = d.breadth || {};
    var amount = at((d.amount || {}).total_yuan, idx);

    var box = el('div', 'tt');
    var head = el('div', 'tt-h');
    head.appendChild(el('span', null, date));
    head.appendChild(el('span', null, ixName));
    box.appendChild(head);
    box.appendChild(el('div', 'tt-sep'));

    function row(label, value, cls) {
      var r = el('div', 'tt-row');
      r.appendChild(el('span', 'tt-k', label));
      r.appendChild(el('span', 'tt-v ' + (cls || ''), value));
      box.appendChild(r);
    }

    row('开', num(at(k.open, idx), 2));
    row('高', num(at(k.high, idx), 2));
    row('低', num(at(k.low, idx), 2));
    row('收', num(at(k.close, idx), 2));
    row('成交额' + (d.amount && d.amount.per_day_estimated && d.amount.per_day_estimated[idx] ? '（估算）' : ''), amount === null ? '—' : yi(amount, 1) + ' 亿元');

    var net = at(b.net, idx);
    box.appendChild(el('div', 'tt-sep'));
    row('上涨', int(at(b.up, idx)), 'pos');
    row('下跌', int(at(b.down, idx)), 'neg');
    row('平盘', int(at(b.flat, idx)));
    row('排除', int(at(b.excluded, idx)));
    row('净上涨', net === null ? '—' : (signed(net, 0) + ' 家'), signCls(net));
    row('覆盖率', pct(at(b.coverage, idx)));

    if (meta.as_of) {
      box.appendChild(el('div', 'tt-sep'));
      var foot = el('div', 'tt-row');
      foot.appendChild(el('span', 'tt-k', '数据时点'));
      foot.appendChild(el('span', 'tt-v', meta.as_of));
      box.appendChild(foot);
    }
    return box.outerHTML;
  }

  function updateTriNote() {
    var note = byId('triNote');
    if (!note || !STATE.chartData) return;
    var dates = STATE.chartData.data.trade_dates || [];
    var total = dates.length;
    var vis = Math.min(STATE.range, total);
    var ixName = (INDEX_LIST.filter(function (x) { return x.code === STATE.index; })[0] || {}).name || STATE.index;
    var meta = STATE.chartData.meta || {};
    note.textContent = '当前：' + ixName + '（' + STATE.index + '） · 显示最近 ' + vis +
      ' 个交易日（共 ' + total + ' 个） · 数据时点 ' + (meta.as_of || '—') +
      ' · 三面板行数必须一致；空位表示该日无数据。';
  }

  /* ==================================================================
   * 2. 板块雷达
   * ================================================================== */

  function initSectors() {
    var key = STATE.sectorTab === 'concept' ? 'sectorsConcept' : 'sectorsIndustry';
    var body = byId('sectorBody');
    if (body) {
      clear(body);
      body.appendChild(el('div', 'loading', '正在读取 ' + FILES[key] + ' …'));
    }
    buildSectorTabs();

    loadJson(FILES[key]).then(function (result) {
      var taxEl = byId('secTaxonomy');
      var rawEl = byId('secTaxonomyRaw');

      if (result.state === 'ok' || result.state === 'stale') {
        var data = result.json.data || {};
        if (taxEl) taxEl.textContent = taxonomyText(data.taxonomy, STATE.sectorTab);
        if (rawEl) rawEl.textContent = data.taxonomy ? String(data.taxonomy) : 'taxonomy 缺失';
      } else {
        if (taxEl) taxEl.textContent = '—';
        if (rawEl) rawEl.textContent = result.state === 'missing' ? '尚未生成' : (result.error || '读取失败');
      }

      renderResult(body, result, function (json) { renderSectors(json); });
    });
  }

  function buildSectorTabs() {
    var wrap = byId('sectorTabs');
    if (!wrap) return;
    clear(wrap);
    [
      ['industry', '行业', FILES.sectorsIndustry],
      ['concept', '概念', FILES.sectorsConcept]
    ].forEach(function (item) {
      var b = el('button', 'chip', item[1]);
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(STATE.sectorTab === item[0]));
      b.dataset.tab = item[0];
      b.addEventListener('click', function () {
        if (STATE.sectorTab === item[0]) return;
        STATE.sectorTab = item[0];
        initSectors();
      });
      wrap.appendChild(b);
    });
  }

  function taxonomyText(tax, tab) {
    var s = String(tax || '');
    if (s.indexOf('industry') >= 0) return '东财行业口径 / 当前成员快照';
    if (s.indexOf('concept') >= 0) return '东财概念口径 / 当前成员快照';
    if (tab === 'concept') return '东财概念口径 / 当前成员快照';
    return '东财行业口径 / 当前成员快照';
  }

  function renderSectors(json) {
    var body = byId('sectorBody');
    if (!body) return;
    var d = json.data || {};
    var meta = json.meta || {};
    var list = Array.isArray(d.sectors) ? d.sectors.slice() : [];

    if (!list.length) {
      body.appendChild(emptyBox('暂无板块数据', 'sectors 数组为空：后端尚未产出该口径的截面。'));
      body.appendChild(metaLine(meta));
      return;
    }

    list.sort(function (a, b) {
      var ra = isNum(a.rank) ? a.rank : 1e9;
      var rb = isNum(b.rank) ? b.rank : 1e9;
      if (ra !== rb) return ra - rb;
      var ha = isNum(a.heat) ? a.heat : -1;
      var hb = isNum(b.heat) ? b.heat : -1;
      return hb - ha;
    });

    var frag = document.createDocumentFragment();
    list.forEach(function (s, i) { frag.appendChild(sectorRow(s, i)); });
    body.appendChild(frag);

    var w = warningsNode(d.warnings || meta.warnings, '板块警告');
    if (w) body.appendChild(w);
    body.appendChild(metaLine(meta, '板块数 ' + list.length));
  }

  function sectorRow(s, i) {
    var row = el('div', 'sec-row');

    var top = el('div', 'sec-top');
    var name = el('div', 'sec-name');
    name.appendChild(el('span', 'sec-rank', '#' + (isNum(s.rank) ? s.rank : (i + 1))));
    name.appendChild(el('b', 'sec-title', s.name || s.sector_id || '—'));

    var sub = [];
    if (s.sector_id) sub.push(s.sector_id);
    if (isNum(s.member_count)) sub.push(s.member_count + ' 只成员');
    if (isNum(s.history_days)) sub.push('历史 ' + s.history_days + ' 天');
    name.appendChild(el('span', 'sec-sub', sub.join(' · ')));
    top.appendChild(name);

    top.appendChild(metricBar('热度', s.heat, 'heat'));
    top.appendChild(metricBar('拥挤度', s.crowding, 'crowd'));
    row.appendChild(top);

    var metaRow = el('div', 'sec-meta');
    metaRow.appendChild(metricSpan('RS5', isNum(s.rs_5d) ? pct(s.rs_5d, 2) : '—'));
    metaRow.appendChild(metricSpan('RS20', isNum(s.rs_20d) ? pct(s.rs_20d, 2) : '—'));
    metaRow.appendChild(metricSpan('上涨占比', pct(s.up_share)));
    metaRow.appendChild(metricSpan('量能比', isNum(s.amount_vs_ma20) ? s.amount_vs_ma20.toFixed(2) + '×' : '—'));
    metaRow.appendChild(metricSpan('涨停', int(s.limit_up_num)));
    metaRow.appendChild(metricSpan('持续性',
      s.persistence === null || s.persistence === undefined ? '—（历史不足）' : num2(s.persistence)));
    row.appendChild(metaRow);

    if (Array.isArray(s.warnings) && s.warnings.length) {
      row.appendChild(el('div', 'sec-warn', s.warnings.map(textOf).filter(Boolean).join('；')));
    }
    return row;
  }

  function metricSpan(k, v) {
    var s = el('span');
    s.appendChild(document.createTextNode(k + ' '));
    s.appendChild(el('b', null, v));
    return s;
  }

  function metricBar(label, v, kind) {
    var w = el('div', 'mbar ' + kind);
    w.appendChild(el('span', 'mbar-k', label));
    var valCls = (kind === 'crowd' && isNum(v) && v >= 70) ? ' warn' : '';
    w.appendChild(el('b', 'mbar-v' + valCls, isNum(v) ? v.toFixed(1) : '—'));
    var b = el('div', 'bar');
    var fill = el('i', kind === 'crowd' ? 'crowd-fill' : '');
    fill.style.width = (isNum(v) ? Math.max(0, Math.min(100, v)) : 0) + '%';
    b.appendChild(fill);
    w.appendChild(b);
    return w;
  }

  /* ==================================================================
   * 3. 低位候选
   * ================================================================== */

  function initCandidates() {
    var key = STATE.horizon === 'medium' ? 'candidatesMedium' : 'candidatesShort';
    var listSlot = byId('candList');
    var degSlot = byId('candDegrade');
    var titleEl = byId('candTitle');
    var subEl = byId('candSub');

    buildHorizonTabs();

    if (listSlot) {
      clear(listSlot);
      listSlot.appendChild(el('div', 'card loading', '正在读取 ' + FILES[key] + ' …'));
    }
    if (degSlot) clear(degSlot);

    loadJson(FILES[key]).then(function (result) {
      if (result.state === 'missing') {
        if (titleEl) titleEl.textContent = STATE.horizon === 'medium' ? '低位候选 · 中期' : '低位候选 · 短期';
        if (subEl) subEl.textContent = '该周期数据尚未生成。';
        renderResult(listSlot, result, function () {});
        return;
      }
      if (result.state === 'error') {
        renderResult(listSlot, result, function () {});
        return;
      }

      var json = result.json || {};
      var d = json.data || {};
      var meta = json.meta || {};
      var degraded = d.degraded === true;
      var fallbackTitle = degraded ? '低位观察候选' : '低位优质候选';
      var title = d.page_title ? String(d.page_title) : fallbackTitle;

      /* 硬规则：degraded 时标题必须出现“观察”，非 degraded 时不得出现 */
      if (degraded && title.indexOf('观察') < 0) title = '低位观察候选';
      if (!degraded && title.indexOf('观察') >= 0) title = '低位优质候选';

      if (titleEl) titleEl.textContent = title;
      if (subEl) {
        subEl.textContent = (STATE.horizon === 'medium' ? '中期' : '短期') +
          ' · 低位与优质分开计算；缺失维度显示「—」，不当作 0 分，也不用价格分替代质量分。';
      }

      renderResult(listSlot, result, function (json2) {
        renderCandidateList(json2);
      });
    });
  }

  function buildHorizonTabs() {
    var wrap = byId('candHorizon');
    if (!wrap) return;
    clear(wrap);
    [['short', '短期'], ['medium', '中期']].forEach(function (item) {
      var b = el('button', 'chip', item[1]);
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(STATE.horizon === item[0]));
      b.dataset.horizon = item[0];
      b.addEventListener('click', function () {
        if (STATE.horizon === item[0]) return;
        STATE.horizon = item[0];
        initCandidates();
      });
      wrap.appendChild(b);
    });
  }

  function renderCandidateList(json) {
    var listSlot = byId('candList');
    var degSlot = byId('candDegrade');
    var d = json.data || {};
    var meta = json.meta || {};

    if (degSlot) {
      clear(degSlot);
      if (d.degraded === true) {
        var box = el('div', 'notice warn');
        box.appendChild(el('span', 'stale-icon', '!'));
        var inner = el('div');
        inner.appendChild(el('b', null, '降级状态：本页只展示低位观察候选'));
        inner.appendChild(el('div', 'err-sub',
          d.degrade_reason ? ('降级原因：' + d.degrade_reason) : '未提供 degrade_reason。'));
        if (d.coverage && typeof d.coverage === 'object') {
          var cov = el('div', 'taglist');
          Object.keys(d.coverage).forEach(function (k) {
            var v = d.coverage[k];
            cov.appendChild(el('span', 'badge warn',
              dimLabel(k) + '覆盖 ' + (isNum(v) ? pct(v, 1) : '—')));
          });
          inner.appendChild(cov);
        }
        box.appendChild(inner);
        degSlot.appendChild(box);
      } else if (d.coverage && typeof d.coverage === 'object') {
        var cov2 = el('div', 'taglist');
        Object.keys(d.coverage).forEach(function (k) {
          var v = d.coverage[k];
          cov2.appendChild(el('span', 'badge', dimLabel(k) + '覆盖 ' + (isNum(v) ? pct(v, 1) : '—')));
        });
        degSlot.appendChild(cov2);
      }
    }

    if (!listSlot) return;
    var items = Array.isArray(d.items) ? d.items : [];
    if (!items.length) {
      listSlot.appendChild(emptyBox('暂无候选', 'items 为空：本期没有通过硬过滤的标的，或数据尚未生成。'));
      return;
    }

    var sorted = items.slice().sort(function (a, b) {
      var sa = isNum(a.candidate_score) ? a.candidate_score : -Infinity;
      var sb = isNum(b.candidate_score) ? b.candidate_score : -Infinity;
      if (sa !== sb) return sb - sa;
      return String(a.ts_code || '').localeCompare(String(b.ts_code || ''));
    });

    sorted.forEach(function (it) { listSlot.appendChild(candidateCard(it, meta)); });

    listSlot.appendChild(metaLine(meta, '候选数 ' + items.length));
    var w = warningsNode(meta.warnings, '数据警告');
    if (w) listSlot.appendChild(w);
  }

  function candidateCard(it, meta) {
    var c = el('div', 'card cand');

    var head = el('div', 'cand-head');
    var nameWrap = el('div');
    var nameLine = el('div');
    nameLine.appendChild(el('b', 'cand-name', it.name || it.ts_code || '—'));
    nameLine.appendChild(el('span', 'cand-code', it.ts_code || ''));
    nameWrap.appendChild(nameLine);

    var badges = el('div', 'cand-badges');
    if (it.group) badges.appendChild(el('span', 'badge', '分组 ' + it.group));
    if (isNum(it.confidence)) {
      badges.appendChild(el('span', 'badge' + (it.confidence < 0.6 ? ' warn' : ''),
        '置信度 ' + pct(it.confidence, 0)));
    }
    if (Array.isArray(it.missing_fields) && it.missing_fields.length) {
      badges.appendChild(el('span', 'badge warn', '缺失字段 ' + it.missing_fields.length + ' 项'));
    }
    if (Array.isArray(it.red_flags) && it.red_flags.length) {
      badges.appendChild(el('span', 'badge danger', '红旗 ' + it.red_flags.length + ' 个'));
    }
    nameWrap.appendChild(badges);
    head.appendChild(nameWrap);

    var scoreWrap = el('div', 'cand-score-wrap');
    scoreWrap.appendChild(el('div', 'cand-score', isNum(it.candidate_score) ? it.candidate_score.toFixed(1) : '—'));
    scoreWrap.appendChild(el('div', 'cand-score-cap',
      isNum(it.candidate_score) ? '综合候选分' : '综合分未计算'));
    head.appendChild(scoreWrap);

    c.appendChild(head);

    /* 六个维度分开显示：缺失一律「—」 */
    var dims = el('div', 'cand-dims');
    [
      ['low_position', it.low_position],
      ['quality', (it.quality !== undefined ? it.quality : it.fundamental_quality)],
      ['valuation', it.valuation],
      ['technical', it.technical],
      ['sector', it.sector],
      ['logic', it.logic]
    ].forEach(function (pair) {
      var box = el('div', 'dim');
      box.appendChild(el('div', 'dim-k', dimLabel(pair[0])));
      box.appendChild(el('div', 'dim-v' + (isNum(pair[1]) ? '' : ' na'),
        isNum(pair[1]) ? pair[1].toFixed(1) : '—'));
      dims.appendChild(box);
    });
    c.appendChild(dims);

    /* 置信度条 */
    var conf = el('div', 'conf-row');
    conf.appendChild(el('span', null, '置信度'));
    conf.appendChild(bar(isNum(it.confidence) ? it.confidence * 100 : null));
    conf.appendChild(el('b', null, isNum(it.confidence) ? pct(it.confidence, 0) : '—'));
    c.appendChild(conf);

    /* 入选理由 */
    var reasons = Array.isArray(it.reasons) ? it.reasons : [];
    var rb = block('入选理由');
    if (reasons.length) {
      var ul = el('ul', 'reason-list');
      reasons.forEach(function (r) {
        var li = el('li', 'reason');
        var dim = r && (r.dimension || r.dim);
        if (dim) li.appendChild(el('span', 'r-dim', dimLabel(dim)));
        li.appendChild(document.createTextNode(textOf(r) || '—'));
        if (r && r.values && typeof r.values === 'object') {
          var vals = el('div', 'r-vals');
          Object.keys(r.values).forEach(function (k) {
            var item = el('span');
            item.appendChild(document.createTextNode(k + ' '));
            item.appendChild(el('b', null, rawValue(r.values[k])));
            vals.appendChild(item);
          });
          li.appendChild(vals);
        }
        ul.appendChild(li);
      });
      rb.appendChild(ul);
    } else {
      rb.appendChild(el('p', 'empty-line', '未提供 reasons。'));
    }
    c.appendChild(rb);

    /* 反方证据 */
    var cb = block('反方证据');
    var ce = Array.isArray(it.counter_evidence) ? it.counter_evidence : [];
    if (ce.length) {
      var cul = el('ul', 'counter');
      ce.forEach(function (x) {
        var t = textOf(x);
        if (t) cul.appendChild(el('li', null, t));
      });
      cb.appendChild(cul);
    } else {
      cb.appendChild(el('p', 'empty-line', '无反方证据记录（不代表没有风险）。'));
    }
    c.appendChild(cb);

    /* 缺失字段 */
    if (Array.isArray(it.missing_fields) && it.missing_fields.length) {
      var mfb = block('缺失字段（不当作 0 分）');
      mfb.appendChild(chipList(it.missing_fields, 'warn'));
      c.appendChild(mfb);
    }

    /* 红旗 */
    var rf = block('红旗');
    var flags = Array.isArray(it.red_flags) ? it.red_flags : [];
    if (flags.length) rf.appendChild(chipList(flags, 'danger'));
    else rf.appendChild(el('p', 'empty-line', '无红旗。'));
    c.appendChild(rf);

    if (!isNum(it.candidate_score)) {
      c.appendChild(el('p', 'note', '综合候选分未计算（多为维度缺失导致），此时不应据此排序。'));
    }
    return c;
  }

  /* ==================================================================
   * 4. 涨停生态
   * ================================================================== */

  function initLimit() {
    loadJson(FILES.limit).then(function (result) {
      var ok = result.state === 'ok' || result.state === 'stale';

      renderResult(byId('limCounts'), result, function (json, container) {
        container.appendChild(renderLimitCounts(json));
      });

      var lad = byId('limLadder');
      var pre = byId('limPremium');
      if (ok) {
        renderResult(lad, result, function (json) { renderLadder(json); });
        renderResult(pre, result, function (json) { renderPremium(json); });
      } else {
        if (lad) { clear(lad); lad.appendChild(el('p', 'empty-line', '—')); }
        if (pre) { clear(pre); pre.appendChild(el('p', 'empty-line', '—')); }
      }

      renderLimitRows(result);

      var noteEl = byId('limNote');
      if (!noteEl) return;
      var bits = ['AKShare 涨停池仅近期，历史自上线日起沉淀。'];
      if (ok) {
        var h = (result.json.data || {}).history || {};
        if (h.start) bits.push('沉淀起点 ' + h.start);
        if (isNum(h.days)) bits.push('已沉淀 ' + h.days + ' 天');
        if (h.note) bits.push(h.note);
      }
      noteEl.textContent = bits.join(' · ');
    });
  }

  function renderLimitCounts(json) {
    var d = json.data || {};
    var meta = json.meta || {};
    var c = (d.counts || {});
    var cardEl = card('计数', '封板率 = 封死 / 触板；连板高度为连续交易日连续涨停数。');
    cardEl.appendChild(kpiGrid([
      ['涨停（封死）', int(c.limit_up), 'pos'],
      ['触板', int(c.touched)],
      ['炸板', int(c.broken), 'neg'],
      ['跌停', int(c.limit_down), 'neg'],
      ['最高连板', isNum(c.ladder_max) ? c.ladder_max + ' 板' : '—'],
      ['封板率', pct(c.seal_rate)]
    ], 'g3'));
    cardEl.appendChild(metaLine(meta, d.as_of ? ('生态时点 ' + d.as_of) : ''));
    return cardEl;
  }

  function renderLadder(json) {
    var box = byId('limLadder');
    var d = json.data || {};
    var ladder = Array.isArray(d.ladder) ? d.ladder : [];
    if (!ladder.length) {
      box.appendChild(el('p', 'empty-line', '暂无连板梯队数据。'));
      return;
    }
    var sorted = ladder.slice().sort(function (a, b) {
      return (isNum(b.height) ? b.height : 0) - (isNum(a.height) ? a.height : 0);
    });
    sorted.forEach(function (g) {
      var row = el('div', 'ladder-row');
      row.appendChild(el('div', 'ladder-h', (isNum(g.height) ? g.height : '—') + ' 连板'));
      var items = el('div', 'ladder-items');
      var list = Array.isArray(g.items) ? g.items : [];
      if (!list.length) items.appendChild(el('span', 'empty-line', '—'));
      list.forEach(function (it) {
        var chip = el('span', 'stock-chip');
        chip.appendChild(el('b', null, it.name || it.ts_code || '—'));
        if (isNum(it.continue_num)) chip.appendChild(el('span', null, it.continue_num + ' 板'));
        else if (it.ts_code) chip.appendChild(el('span', null, it.ts_code));
        items.appendChild(chip);
      });
      row.appendChild(items);
      box.appendChild(row);
    });
  }

  function renderLimitRows(result) {
    var tbody = byId('limRows');
    if (!tbody) return;
    clear(tbody);

    if (result.state !== 'ok' && result.state !== 'stale') {
      var tr = el('tr');
      var td = el('td', 'empty-cell', result.state === 'missing' ? '该模块尚未生成' : '读取失败');
      td.colSpan = 6;
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }

    var items = Array.isArray((result.json.data || {}).items) ? result.json.data.items : [];
    if (!items.length) {
      var tr2 = el('tr');
      var td2 = el('td', 'empty-cell', '今日无涨停明细');
      td2.colSpan = 6;
      tr2.appendChild(td2);
      tbody.appendChild(tr2);
      return;
    }

    items.forEach(function (it) {
      var tr = el('tr');
      tr.appendChild(el('td', null, it.name || it.ts_code || '—'));
      tr.appendChild(el('td', null, it.industry || '—'));
      tr.appendChild(el('td', null, it.first_seal_time || '—'));
      tr.appendChild(el('td', null, isNum(it.open_num) ? String(it.open_num) : '—'));
      var seal = el('td', null, sealAmount(it.order_amount_yuan));
      if (sealAmount(it.order_amount_yuan) === '—') seal.className = 'na';
      tr.appendChild(seal);
      tr.appendChild(el('td', null, fillabilityLabel(it.fillability)));
      tr.title = [it.ts_code, it.limit_type ? ('板型 ' + it.limit_type) : '',
        it.sector_limit_up_num !== undefined ? ('板块涨停 ' + it.sector_limit_up_num) : '',
        it.reason || ''].filter(Boolean).join(' · ');
      tbody.appendChild(tr);
    });
  }

  function sealAmount(v) {
    if (!isNum(v)) return '—';
    if (v >= 1e8) return (v / 1e8).toFixed(2) + ' 亿';
    if (v >= 1e4) return (v / 1e4).toFixed(0) + ' 万';
    return String(Math.round(v)) + ' 元';
  }

  function fillabilityLabel(v) {
    if (!v) return '—';
    var map = { hard: '不可成交', soft: '较难', easy: '可能成交', none: '不可成交' };
    return map[String(v)] || String(v);
  }

  function renderPremium(json) {
    var box = byId('limPremium');
    var d = json.data || {};
    var p = d.premium || {};
    var grid = kpiGrid([
      ['理论溢价', isNum(p.theoretical) ? pct(p.theoretical, 2) : '—'],
      ['可成交样本溢价', isNum(p.tradable_sample) ? pct(p.tradable_sample, 2) : '—'],
      ['样本量', int(p.sample_n)]
    ], 'g3');
    box.appendChild(grid);
    box.appendChild(el('p', 'note',
      '样本量不足或无成交口径时不计算溢价（显示「—」），也不写任何收益率结论。'));
  }

  /* ==================================================================
   * 5. 研究状态
   * ================================================================== */

  var RESEARCH_SECTIONS = [
    ['strategies', '策略版本'],
    ['walk_forward', '走查结果'],
    ['shadow_ledger', '影子账本'],
    ['factors', '因子定义'],
    ['notes', '说明']
  ];

  function initResearch() {
    var body = byId('researchBody');
    if (body) {
      clear(body);
      body.appendChild(el('div', 'card loading', '正在读取 ' + FILES.research + ' …'));
    }
    loadJson(FILES.research).then(function (result) {
      renderResult(body, result, function (json) { renderResearch(json); });
    });
  }

  function renderResearch(json) {
    var body = byId('researchBody');
    if (!body) return;
    var d = json.data || {};
    var meta = json.meta || {};

    var known = {};
    RESEARCH_SECTIONS.forEach(function (s) { known[s[0]] = true; });

    var rendered = 0;

    RESEARCH_SECTIONS.forEach(function (sec) {
      var key = sec[0];
      var val = d[key];
      if (val === undefined || val === null) return;
      rendered++;

      var c = card(sec[1], null);
      if (Array.isArray(val)) {
        if (!val.length) {
          c.appendChild(el('p', 'empty-line', '尚未生成。'));
        } else {
          val.forEach(function (item, i) {
            if (item === null || typeof item !== 'object') {
              c.appendChild(el('p', 'empty-line', String(item)));
              return;
            }
            var sub_ = el('div', 'ind');
            sub_.appendChild(el('div', 'ind-name', item.name || item.strategy_id || item.factor_id || ('条目 ' + (i + 1))));
            var pairs = [];
            Object.keys(item).forEach(function (k) {
              if (k === 'name' || k === 'strategy_id' || k === 'factor_id') return;
              var v = item[k];
              pairs.push([fieldLabel(k), valueText(v), statusCls(k, v)]);
            });
            sub_.appendChild(kvGrid(pairs));
            c.appendChild(sub_);
          });
        }
      } else if (typeof val === 'object') {
        var pairs2 = [];
        Object.keys(val).forEach(function (k) {
          pairs2.push([fieldLabel(k), valueText(val[k]), '']);
        });
        c.appendChild(kvGrid(pairs2));
      } else {
        c.appendChild(el('p', 'empty-line', String(val)));
      }
      c.appendChild(metaLine(meta));
      body.appendChild(c);
    });

    /* 未知字段也展示，避免“后端加了字段前端看不到” */
    Object.keys(d).forEach(function (k) {
      if (known[k]) return;
      var v = d[k];
      if (v === null || v === undefined) return;
      rendered++;
      var c2 = card(fieldLabel(k), null);
      if (Array.isArray(v)) {
        if (!v.length) c2.appendChild(el('p', 'empty-line', '尚未生成。'));
        v.forEach(function (item, i) {
          if (item && typeof item === 'object') {
            var pairs = [];
            Object.keys(item).forEach(function (kk) {
              pairs.push([fieldLabel(kk), valueText(item[kk]), '']);
            });
            var blk = el('div', 'ind');
            blk.appendChild(el('div', 'ind-name', '条目 ' + (i + 1)));
            blk.appendChild(kvGrid(pairs));
            c2.appendChild(blk);
          } else if (item !== null && item !== undefined) {
            c2.appendChild(el('p', 'empty-line', String(item)));
          }
        });
      } else if (typeof v === 'object') {
        var pairs3 = [];
        Object.keys(v).forEach(function (kk) {
          pairs3.push([fieldLabel(kk), valueText(v[kk]), '']);
        });
        c2.appendChild(kvGrid(pairs3));
      } else {
        c2.appendChild(el('p', 'empty-line', String(v)));
      }
      c2.appendChild(metaLine(meta));
      body.appendChild(c2);
    });

    if (!rendered) {
      body.appendChild(emptyBox('暂无研究数据',
        'research_status.json 存在但没有可展示字段；请后端补齐 strategies / walk_forward / shadow_ledger。'));
    }
  }

  function valueText(v) {
    if (v === null || v === undefined) return '—';
    if (typeof v === 'number') return rawValue(v);
    if (typeof v === 'boolean') return v ? '是' : '否';
    if (Array.isArray(v)) {
      var arr = v.map(function (x) { return typeof x === 'object' ? (textOf(x) || '…') : String(x); });
      return arr.length ? arr.join('、') : '—';
    }
    if (typeof v === 'object') {
      var bits = [];
      Object.keys(v).forEach(function (k) {
        bits.push(fieldLabel(k) + ' ' + valueText(v[k]));
      });
      return bits.join(' · ');
    }
    return String(v);
  }

  function statusCls(key, v) {
    if (key !== 'status') return '';
    var s = String(v);
    if (s === 'ok') return 'pos';
    if (s === 'failed' || s === 'error') return 'neg';
    return '';
  }

  /* ==================================================================
   * 6. 系统状态
   * ================================================================== */

  function initSystem() {
    loadJson(FILES.system).then(function (result) {
      var overall = byId('sysOverall');
      renderResult(overall, result, function (json, container) {
        container.appendChild(renderSystemOverall(json));
      });

      renderSystemDatasets(result);
      renderSystemRuns(result);
      renderSystemMeta(result);
    });
  }

  function renderSystemOverall(json) {
    var d = json.data || {};
    var meta = json.meta || {};
    var c = card('总览', '健康灯取 status / overall；过期数据不得冒充当前数据。');
    c.appendChild(kpiGrid([
      ['总体状态', statusLabel(d.overall), 'sm'],
      ['数据时点', meta.as_of || '—', 'sm'],
      ['数据集数', int((d.datasets || []).length), 'sm'],
      ['任务记录', int((d.runs || []).length), 'sm']
    ]));
    c.appendChild(metaLine(meta));
    var w = warningsNode(meta.warnings, '系统警告');
    if (w) c.appendChild(w);
    return c;
  }

  function renderSystemDatasets(result) {
    var tbody = byId('sysDatasets');
    if (!tbody) return;
    clear(tbody);

    if (result.state !== 'ok' && result.state !== 'stale') {
      var tr = el('tr');
      var td = el('td', 'empty-cell', result.state === 'missing' ? '该模块尚未生成' : '读取失败');
      td.colSpan = 6;
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }

    var rows = Array.isArray((result.json.data || {}).datasets) ? result.json.data.datasets : [];
    if (!rows.length) {
      var tr2 = el('tr');
      var td2 = el('td', 'empty-cell', '暂无数据集记录');
      td2.colSpan = 6;
      tr2.appendChild(td2);
      tbody.appendChild(tr2);
      return;
    }

    rows.forEach(function (ds) {
      var tr = el('tr');
      tr.appendChild(el('td', null, ds.dataset_id || '—'));
      var st = el('td', null, statusLabel(ds.status));
      if (ds.status === 'ok') st.className = 'pos';
      else if (ds.status === 'stale' || ds.status === 'unavailable') st.className = 'neg';
      tr.appendChild(st);
      tr.appendChild(el('td', 'num', int(ds.rows)));
      tr.appendChild(el('td', null, ds.as_of || '—'));
      tr.appendChild(el('td', null, ds.quality_tier || '—'));
      var w = Array.isArray(ds.warnings) && ds.warnings.length ? ds.warnings.map(textOf).join('；') : '—';
      var wtd = el('td', null, w);
      wtd.style.whiteSpace = 'normal';
      wtd.style.minWidth = '150px';
      tr.appendChild(wtd);
      tbody.appendChild(tr);
    });
  }

  function renderSystemRuns(result) {
    var box = byId('sysRuns');
    if (!box) return;
    clear(box);

    if (result.state !== 'ok' && result.state !== 'stale') {
      box.appendChild(el('p', 'empty-line', result.state === 'missing' ? '该模块尚未生成' : '读取失败'));
      return;
    }

    var runs = Array.isArray((result.json.data || {}).runs) ? result.json.data.runs : [];
    if (!runs.length) {
      box.appendChild(el('p', 'empty-line', '暂无运行记录'));
      return;
    }

    var grid = el('div', 'kv-grid');
    runs.forEach(function (r) {
      var row = el('div', 'kv');
      row.appendChild(el('span', 'kv-k', (r.job || r.run_id || '—')));
      var v = el('b', 'kv-v',
        statusLabel(r.status) + ' · ' +
        (r.started_at ? String(r.started_at).replace('T', ' ') : '—') +
        (isNum(r.duration_s) ? (' · ' + r.duration_s + 's') : ' · —'));
      if (r.status === 'ok') v.className = 'kv-v pos';
      else if (r.status === 'failed' || r.status === 'error') v.className = 'kv-v neg';
      row.appendChild(v);
      grid.appendChild(row);
    });
    box.appendChild(grid);
  }

  function renderSystemMeta(result) {
    var box = byId('sysMeta');
    if (!box) return;
    clear(box);

    if (result.state !== 'ok' && result.state !== 'stale') {
      box.appendChild(el('p', 'empty-line', result.state === 'missing' ? '该模块尚未生成' : '读取失败'));
      return;
    }

    var d = result.json.data || {};
    var pairs = [];

    var mv = d.model_versions;
    if (mv && typeof mv === 'object') {
      Object.keys(mv).forEach(function (k) {
        pairs.push([fieldLabel(k) + ' 模型', String(mv[k])]);
      });
    }

    var disk = d.disk || {};
    if (isNum(disk.db_mb)) pairs.push(['数据库大小', disk.db_mb.toFixed(1) + ' MB']);
    else pairs.push(['数据库大小', '—']);

    if (!pairs.length) {
      box.appendChild(el('p', 'empty-line', '未提供 model_versions / disk。'));
      return;
    }
    box.appendChild(kvGrid(pairs));
  }

  /* ==================================================================
   * 启动
   * ================================================================== */

  function cacheDom() {
    DOM.topwrap = byId('topwrap');
    DOM.staleBanner = byId('staleBanner');
    DOM.staleDetail = byId('staleDetail');
    DOM.tbAsOf = byId('tbAsOf');
    DOM.tbMode = byId('tbMode');
    DOM.tbLight = byId('tbLight');
    DOM.tbLightText = byId('tbLightText');
    DOM.tbModel = byId('tbModel');
    DOM.themeBtn = byId('themeBtn');
    DOM.refreshBtn = byId('refreshBtn');
    DOM.toast = byId('toast');
  }

  function boot() {
    cacheDom();
    initTheme();
    bindGlobal();
    syncTopOffset();
    setTimeout(syncTopOffset, 260);

    var target = String(location.hash || '').replace('#', '');
    if (!Object.prototype.hasOwnProperty.call(PAGE_READY, target)) target = 'overview';
    switchPage(target);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
