// ==UserScript==
// @name         豆瓣看过-批量标签助手
// @namespace    https://github.com/rainnn-w/douban-batch-tags
// @version      3.3
// @description  在豆瓣“看过”页面批量添加/移除标签：面板内电影列表勾选、片名搜索、
//               无标签/评分/年份/已有标签筛选、预设标签、跨页加载全部条目、
//               进度条与失败重试。以用户本人登录态提交，内置随机延迟防风控。
// @author       rainnn-w
// @license      MIT
// @match        https://movie.douban.com/people/*/collect*
// @grant        none
// @icon         https://movie.douban.com/favicon.ico
// @homepageURL  https://github.com/rainnn-w/douban-batch-tags
// @supportURL   https://github.com/rainnn-w/douban-batch-tags/issues
// ==/UserScript==

/* ⚠️ 使用前必读：
 * 1. 先手动改 1 部电影的标签，用 F12→Network 确认 POST /j/subject/{id}/interest 的字段
 * 2. 批量前先拿 1~2 部测试，确认评分和短评没被误清
 * 3. 请求间的随机延迟勿删，防风控
 */
(function () {
  'use strict';

  // ============ 配置 ============
  const DELAY = [1500, 3000];        // 编辑请求随机延迟(ms)
  const PAGE_DELAY = 800;            // 加载翻页的间隔(ms)
  const MAX_PAGES = 40;              // 最多加载多少页(每页25部)
  const SEND_PARSED_RATING = true;   // 提交时带上解析到的星级（防误清评分）
  const CK = document.cookie.match(/ck=([^;]+)/)?.[1];
  const UID = location.pathname.match(/people\/([^\/]+)/)?.[1];
  const LS_KEY = 'douban_batch_tags_presets';

  if (!CK || !UID) { alert('未找到 ck 或用户ID，请确认已登录且在“看过”页面'); return; }

  // ============ 工具 ============
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const rand = () => DELAY[0] + Math.random() * (DELAY[1] - DELAY[0]);

  // ============ 条目解析 ============
  function parseItems(doc) {
    return [...doc.querySelectorAll('#content .item')].map(item => {
      const a = item.querySelector('.title a');
      const id = a?.href.match(/subject\/(\d+)/)?.[1];
      if (!a || !id) return null;
      const tagMatch = item.textContent.match(/标签:\s*([^\n]+)/);
      const tags = tagMatch ? tagMatch[1].trim().split(/\s+/).filter(Boolean) : [];
      const ratingM = item.innerHTML.match(/(?:allstar|rating)([1-9])0/);
      const clone = item.cloneNode(true);
      clone.querySelectorAll('.date').forEach(d => d.remove());
      const years = [...new Set(clone.textContent.match(/(?:19|20)\d{2}/g) || [])].map(Number);
      return { id, title: a.textContent.trim(), tags, rating: ratingM ? +ratingM[1] : 0,
               years, checked: false, done: false, failed: false };
    }).filter(Boolean);
  }

  // 当前页 + 跨页统一存这里（id 去重）
  const store = new Map();
  parseItems(document).forEach(m => store.set(m.id, m));

  // ============ 样式 ============
  const style = document.createElement('style');
  style.textContent = `
    .bt-panel{position:fixed;top:80px;right:20px;z-index:99999;width:300px;
      background:#fff;border:1px solid #d5e5d5;border-radius:10px;overflow:hidden;
      box-shadow:0 4px 16px rgba(0,80,0,.18);font:13px/1.6 sans-serif;color:#333;}
    .bt-head{background:#072;color:#fff;padding:8px 12px;cursor:move;user-select:none;
      display:flex;justify-content:space-between;align-items:center;font-weight:bold;}
    .bt-toggle{cursor:pointer;padding:0 6px;}
    .bt-body{padding:10px 12px;max-height:76vh;overflow:auto;}
    .bt-sec{border-left:3px solid #42bd56;padding-left:6px;margin:10px 0 4px;font-weight:bold;color:#072;}
    .bt-btn{background:#42bd56;color:#fff;border:none;border-radius:4px;padding:4px 10px;cursor:pointer;margin:2px 2px 2px 0;}
    .bt-btn:hover{background:#072;}
    .bt-btn:disabled{background:#bbb;cursor:not-allowed;}
    .bt-mini{background:#f2f8f2;color:#333;border:1px solid #bcd;}
    .bt-chip{display:inline-block;background:#eef7ee;border:1px solid #9c9;border-radius:12px;
      padding:1px 9px;margin:2px 3px;cursor:pointer;user-select:none;}
    .bt-chip.on{background:#42bd56;color:#fff;border-color:#42bd56;}
    .bt-tagpick{max-height:120px;overflow:auto;border:1px solid #e0ece0;border-radius:6px;padding:4px;background:#fbfdfb;}
    .bt-chip small{opacity:.7;font-size:10px;}
    .bt-prog-wrap{height:8px;background:#e5eee5;border-radius:4px;margin-top:8px;overflow:hidden;}
    .bt-prog-bar{height:100%;width:0;background:linear-gradient(90deg,#42bd56,#072);transition:width .3s;}
    .bt-log{margin-top:6px;max-height:130px;overflow:auto;font-size:12px;color:#555;
      background:#fafcfa;border:1px solid #eee;border-radius:4px;padding:4px;}
    .bt-row{margin:3px 0;}
    .bt-panel input[type=text],.bt-panel input:not([type]),.bt-panel select{border:1px solid #ccc;border-radius:4px;padding:3px 5px;}
    /* 电影列表 */
    .bt-list{max-height:240px;overflow:auto;border:1px solid #e0ece0;border-radius:6px;padding:4px;margin-top:4px;background:#fbfdfb;}
    .bt-mrow{display:flex;align-items:center;gap:6px;padding:3px 5px;border-radius:4px;cursor:pointer;}
    .bt-mrow:hover{background:#e8f5e8;}
    .bt-mrow input[type=checkbox]{width:15px;height:15px;accent-color:#072;cursor:pointer;flex:none;}
    .bt-mtitle{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .bt-mtags{color:#999;font-size:11px;max-width:86px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:none;}
    .bt-done{opacity:.45;}
    .bt-done .bt-mtitle{text-decoration:line-through;}
    .bt-fail .bt-mtitle{color:#c00;}
  `;
  document.head.appendChild(style);

  // ============ 面板 ============
  const panel = document.createElement('div');
  panel.className = 'bt-panel';
  panel.innerHTML = `
    <div class="bt-head"><span>🏷️ 批量标签助手</span><span class="bt-toggle">—</span></div>
    <div class="bt-body">
      <div class="bt-sec">电影列表（勾选要处理的）</div>
      <div class="bt-row">
        <input type="text" id="bt-search" style="width:100%" placeholder="🔍 按片名搜索当前列表">
      </div>
      <div class="bt-list" id="bt-list"></div>
      <div class="bt-row">
        <button class="bt-btn bt-mini" id="bt-selall">全选</button>
        <button class="bt-btn bt-mini" id="bt-invert">反选</button>
        <button class="bt-btn bt-mini" id="bt-clearsel">清除选择</button>
        <button class="bt-btn" id="bt-loadall">📥 加载全部页</button>
      </div>
      <div id="bt-count" style="color:#888;"></div>

      <div class="bt-sec">列表筛选（只影响显示，实时生效）</div>
      <div class="bt-row"><label><input type="checkbox" id="bt-untagged"> 只看无标签</label></div>
      <div class="bt-row">已有标签筛选（点击选取，可多选）：</div>
      <div class="bt-tagpick" id="bt-tagpick"></div>
      <div class="bt-row">评分:
        <select id="bt-rating"><option value="">全部</option><option value="0">未评分</option>
        ${[1,2,3,4,5].map(n=>`<option value="${n}">${n}星</option>`).join('')}</select>
        年份 <input type="text" id="bt-ymin" size="4" placeholder="如1990"> -
        <input type="text" id="bt-ymax" size="4" placeholder="如2000">
        <button class="bt-btn bt-mini" id="bt-clearfilter">清除筛选</button></div>

      <div class="bt-sec">预设标签（左键选入，右键删除）</div>
      <div id="bt-chips"></div>
      <div class="bt-row"><input type="text" id="bt-newchip" placeholder="新标签，回车添加" size="14">
        <button class="bt-btn bt-mini" id="bt-addchip">＋添加</button></div>

      <div class="bt-sec">本次操作</div>
      <div class="bt-row">添加标签：<input type="text" id="bt-add" style="width:100%" placeholder="空格分隔"></div>
      <div class="bt-row">移除标签：<input type="text" id="bt-del" style="width:100%" placeholder="留空不移除"></div>
      <button class="bt-btn" id="bt-run">▶ 开始处理勾选项</button>
      <button class="bt-btn" id="bt-abort" disabled>■ 停止</button>
      <button class="bt-btn bt-mini" id="bt-retry" style="display:none">↻ 重试失败项</button>
      <div class="bt-prog-wrap"><div class="bt-prog-bar" id="bt-bar"></div></div>
      <div id="bt-ptext" style="color:#888;font-size:12px;"></div>
      <div class="bt-log" id="bt-log"></div>
    </div>`;
  document.body.appendChild(panel);

  const $ = id => document.getElementById(id);
  const log = s => { const el = $('bt-log'); el.innerHTML += esc(s) + '<br>'; el.scrollTop = el.scrollHeight; };

  // ============ 折叠 / 拖拽 ============
  panel.querySelector('.bt-toggle').onclick = e => {
    const body = panel.querySelector('.bt-body');
    const show = body.style.display === 'none';
    body.style.display = show ? '' : 'none';
    e.target.textContent = show ? '—' : '+';
  };
  panel.querySelector('.bt-head').addEventListener('pointerdown', e => {
    if (e.target.classList.contains('bt-toggle')) return;
    const r = panel.getBoundingClientRect();
    const dx = e.clientX - r.left, dy = e.clientY - r.top;
    const move = ev => {
      panel.style.left = (ev.clientX - dx) + 'px';
      panel.style.top = (ev.clientY - dy) + 'px';
      panel.style.right = 'auto';
    };
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
    addEventListener('pointermove', move); addEventListener('pointerup', up);
  });

  // ============ 筛选状态（只影响列表显示，不影响勾选） ============
  const filterState = { untagged: false, rating: '', ymin: '', ymax: '', tags: [] };

  function visibleList() {
    const kw = $('bt-search').value.trim().toLowerCase();
    const ymin = +filterState.ymin || -Infinity, ymax = +filterState.ymax || Infinity;
    const hasYear = filterState.ymin || filterState.ymax;
    const wantTags = filterState.tags.map(w => w.toLowerCase());
    return [...store.values()].filter(m => {
      if (kw && !m.title.toLowerCase().includes(kw)) return false;
      if (filterState.untagged && m.tags.length) return false;
      if (filterState.rating !== '' && m.rating !== +filterState.rating) return false;
      if (hasYear && !m.years.some(y => y >= ymin && y <= ymax)) return false;
      if (wantTags.length && !m.tags.some(t => wantTags.includes(t.toLowerCase()))) return false;
      return true;
    });
  }

  // ============ 面板内电影列表 ============
  function renderList() {
    const list = visibleList();
    renderTagPicker();
    $('bt-list').innerHTML = list.map(m => `
      <label class="bt-mrow ${m.done ? 'bt-done' : ''} ${m.failed ? 'bt-fail' : ''}">
        <input type="checkbox" data-id="${m.id}" ${m.checked ? 'checked' : ''} ${m.done ? 'disabled' : ''}>
        <span class="bt-mtitle" title="${esc(m.title)}">${m.done ? '✅ ' : ''}${esc(m.title)}</span>
        <span class="bt-mtags" title="已有标签">${esc(m.tags.join(' ') || '无标签')}</span>
      </label>`).join('') || '<div style="color:#999;padding:8px;">（无匹配条目）</div>';
    updateCount();
  }
  $('bt-list').addEventListener('change', e => {
    if (e.target.matches('input[type=checkbox]')) {
      const m = store.get(e.target.dataset.id);
      if (m && !m.done) m.checked = e.target.checked;
      updateCount();
    }
  });
  $('bt-search').addEventListener('input', renderList);

  function updateCount() {
    const all = store.size;
    const sel = [...store.values()].filter(m => m.checked).length;
    const done = [...store.values()].filter(m => m.done).length;
    $('bt-count').textContent = `共 ${all} 部 · 已选 ${sel} 部 · 已处理 ${done} 部`;
  }

  // 全选 / 反选 / 清除（作用于当前可见项）
  $('bt-selall').onclick = () => { visibleList().forEach(m => { if (!m.done) m.checked = true; }); renderList(); };
  $('bt-invert').onclick = () => { visibleList().forEach(m => { if (!m.done) m.checked = !m.checked; }); renderList(); };
  $('bt-clearsel').onclick = () => { store.forEach(m => m.checked = false); renderList(); };

  // ============ 列表筛选（实时生效） ============
  $('bt-untagged').onchange = e => { filterState.untagged = e.target.checked; renderList(); };

  // 自动提取全部条目的现有标签，做成可点击胶囊（带数量）
  function renderTagPicker() {
    const counts = new Map();
    store.forEach(m => m.tags.forEach(t => counts.set(t, (counts.get(t) || 0) + 1)));
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh'));
    const sel = new Set(filterState.tags.map(t => t.toLowerCase()));
    $('bt-tagpick').innerHTML = sorted.length
      ? sorted.map(([t, c]) =>
          `<span class="bt-chip ${sel.has(t.toLowerCase()) ? 'on' : ''}" data-t="${esc(t)}">${esc(t)}<small> ${c}</small></span>`).join('')
      : '<span style="color:#999;font-size:12px;">（暂无标签：加载全部页后自动汇总，或先处理几部）</span>';
    $('bt-tagpick').querySelectorAll('.bt-chip').forEach(chip => {
      chip.onclick = () => toggleTagFilter(chip.dataset.t);
    });
  }
  function toggleTagFilter(tag) {
    const lower = tag.toLowerCase();
    filterState.tags = filterState.tags.some(t => t.toLowerCase() === lower)
      ? filterState.tags.filter(t => t.toLowerCase() !== lower)
      : [...filterState.tags, tag];
    renderList();
  }
  $('bt-rating').onchange  = e => { filterState.rating = e.target.value; renderList(); };
  $('bt-ymin').addEventListener('input', e => { filterState.ymin = e.target.value; renderList(); });
  $('bt-ymax').addEventListener('input', e => { filterState.ymax = e.target.value; renderList(); });
  $('bt-clearfilter').onclick = () => {
    Object.assign(filterState, { untagged: false, rating: '', ymin: '', ymax: '', tags: [] });
    $('bt-untagged').checked = false; $('bt-rating').value = '';
    $('bt-ymin').value = ''; $('bt-ymax').value = '';
    renderList();
  };

  // ============ 跨页加载 ============
  let loading = false;
  $('bt-loadall').onclick = async () => {
    if (loading) return;
    loading = true;
    $('bt-loadall').disabled = true;
    const before = store.size;
    try {
      for (let page = 0; page < MAX_PAGES; page++) {
        const start = page * 25;
        $('bt-ptext').textContent = `加载第 ${page + 1} 页...`;
        const res = await fetch(
          `https://movie.douban.com/people/${UID}/collect?start=${start}&sort=time&rating=all&filter=all&mode=detail`,
          { credentials: 'include' });
        if (!res.ok) throw new Error(`第 ${page + 1} 页 HTTP ${res.status}`);
        const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
        const items = parseItems(doc);
        items.forEach(m => { if (!store.has(m.id)) store.set(m.id, m); });
        renderList();
        if (items.length < 25) { log(`已到最后一页（第 ${page + 1} 页）`); break; }
        await sleep(PAGE_DELAY);
      }
      log(`加载完成：${before} → ${store.size} 部`);
    } catch (e) {
      log(`⚠️ 加载中断: ${e.message}`);
    }
    $('bt-loadall').disabled = false;
    loading = false;
    $('bt-ptext').textContent = '';
  };

  // ============ 预设标签 ============
  let presets = JSON.parse(localStorage.getItem(LS_KEY) || '["科幻","悬疑","剧情","喜剧","经典"]');
  function renderChips() {
    $('bt-chips').innerHTML = presets.map(t => `<span class="bt-chip" data-t="${esc(t)}">${esc(t)}</span>`).join('');
    $('bt-chips').querySelectorAll('.bt-chip').forEach(chip => {
      chip.onclick = () => toggleTagInInput(chip.dataset.t);
      chip.oncontextmenu = e => {
        e.preventDefault();
        presets = presets.filter(t => t !== chip.dataset.t);
        localStorage.setItem(LS_KEY, JSON.stringify(presets));
        renderChips();
      };
    });
    syncChipsWithInput();
  }
  function toggleTagInInput(tag) {
    const inp = $('bt-add');
    let tokens = inp.value.trim().split(/\s+/).filter(Boolean);
    tokens = tokens.includes(tag) ? tokens.filter(t => t !== tag) : [...tokens, tag];
    inp.value = tokens.join(' ');
    syncChipsWithInput();
  }
  function syncChipsWithInput() {
    const tokens = $('bt-add').value.trim().split(/\s+/).filter(Boolean);
    $('bt-chips').querySelectorAll('.bt-chip').forEach(chip =>
      chip.classList.toggle('on', tokens.includes(chip.dataset.t)));
  }
  $('bt-add').addEventListener('input', syncChipsWithInput);
  $('bt-addchip').onclick = addChip;
  $('bt-newchip').addEventListener('keydown', e => { if (e.key === 'Enter') addChip(); });
  function addChip() {
    const v = $('bt-newchip').value.trim();
    if (v && !presets.includes(v)) {
      presets.push(v);
      localStorage.setItem(LS_KEY, JSON.stringify(presets));
      renderChips();
    }
    $('bt-newchip').value = '';
  }
  renderChips();

  // ============ 批量执行 ============
  let abortFlag = false, running = false;

  async function submitOne(m, tags) {
    const f = new URLSearchParams({ interest: 'collect', tags: tags.join(' '), comment: '' });
    if (SEND_PARSED_RATING && m.rating) f.set('rating', String(m.rating));
    const res = await fetch(`https://movie.douban.com/j/subject/${m.id}/interest?ck=${CK}`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: f,
    });
    return res.ok;
  }

  function markRow(m) {
    const cb = document.querySelector(`#bt-list input[data-id="${m.id}"]`);
    if (cb) {
      cb.checked = false; cb.disabled = true;
      const row = cb.closest('.bt-mrow');
      row.classList.remove('bt-fail');
      row.classList.add('bt-done');
      const t = row.querySelector('.bt-mtitle');
      if (t && !t.textContent.startsWith('✅')) t.textContent = '✅ ' + t.textContent;
    }
  }

  async function runBatch(list) {
    if (running || !list.length) return;
    running = true; abortFlag = false;
    $('bt-run').disabled = true; $('bt-abort').disabled = false; $('bt-retry').style.display = 'none';
    const add = $('bt-add').value.trim().split(/\s+/).filter(Boolean);
    const del = $('bt-del').value.trim().split(/\s+/).filter(Boolean);
    let okN = 0;
    const failedNow = [];

    for (let i = 0; i < list.length; i++) {
      if (abortFlag) { log('⏹ 已手动停止'); break; }
      const m = list[i];
      m.checked = false;
      const tags = [...new Set([...m.tags.filter(t => !del.includes(t)), ...add])];
      $('bt-bar').style.width = ((i / list.length) * 100) + '%';
      $('bt-ptext').textContent = `进度 ${i + 1}/${list.length}`;
      try {
        if (await submitOne(m, tags)) {
          log(`✅ ${m.title} → ${tags.join(' ') || '(清空标签)'}`);
          m.done = true; okN++;
          markRow(m);
        } else {
          log(`⚠️ ${m.title} 请求失败`);
          m.failed = true; failedNow.push(m);
        }
      } catch (e) {
        log(`❌ ${m.title}: ${e.message}`);
        m.failed = true; failedNow.push(m);
      }
      await sleep(rand());
    }
    $('bt-bar').style.width = '100%';
    $('bt-ptext').textContent = `本轮完成：成功 ${okN} / 失败 ${failedNow.length}`;
    if (failedNow.length) {
      window.__btFailed = failedNow;
      $('bt-retry').style.display = '';
      $('bt-retry').textContent = `↻ 重试失败项 (${failedNow.length})`;
      log(`有 ${failedNow.length} 部失败，可点重试`);
    }
    running = false;
    $('bt-run').disabled = false; $('bt-abort').disabled = true;
    renderList();
  }

  $('bt-run').onclick = () => {
    const list = [...store.values()].filter(m => m.checked && !m.done);
    if (!list.length) return alert('请先在列表中勾选要处理的条目');
    if (confirm(`将处理 ${list.length} 部电影，继续？`)) runBatch(list);
  };
  $('bt-abort').onclick = () => abortFlag = true;
  $('bt-retry').onclick = () => {
    const list = window.__btFailed || [];
    window.__btFailed = [];
    $('bt-retry').style.display = 'none';
    runBatch(list);
  };

  renderList();
})();
