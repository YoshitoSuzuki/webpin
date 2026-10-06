// ページに注入される UI。Shadow DOM の中だけで完結させ、ページ側の CSS と干渉させない。
(function () {
  if (window.__webpin) return;
  window.__webpin = true;

  var API = '/__webpin/';
  var mode = null;
  var notes = [];
  var host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647';
  var root = host.attachShadow({ mode: 'open' });
  document.documentElement.appendChild(host);

  var CSS_TEXT = [
    ':host{all:initial}',
    '*{box-sizing:border-box;font-family:-apple-system,"Hiragino Sans",sans-serif}',
    '.bar{position:fixed;right:16px;bottom:16px;display:flex;gap:4px;background:#111;color:#fff;',
    'padding:4px;border-radius:10px;box-shadow:0 4px 20px rgba(0,0,0,.35);font-size:13px}',
    '.bar button{all:unset;padding:6px 10px;border-radius:7px;cursor:pointer;color:#fff;line-height:1}',
    '.bar button:hover{background:#333}',
    '.bar button.on{background:#2f7cf6}',
    '.hl{position:fixed;pointer-events:none;border:2px solid #2f7cf6;border-radius:3px;',
    'background:rgba(47,124,246,.12)}',
    '.sel{position:fixed;pointer-events:none;border:2px dashed #2f7cf6;background:rgba(47,124,246,.1)}',
    '.pin{position:absolute;width:20px;height:20px;border-radius:50%;background:#2f7cf6;color:#fff;',
    'font-size:11px;display:flex;align-items:center;justify-content:center;cursor:pointer;',
    'box-shadow:0 1px 6px rgba(0,0,0,.4)}',
    '.pin.done{background:#7a8290}',
    '.pop{position:absolute;background:#fff;color:#111;border-radius:10px;padding:8px;',
    'box-shadow:0 8px 30px rgba(0,0,0,.25);display:flex;flex-direction:column;gap:6px;min-width:240px}',
    '.pop textarea{width:100%;height:64px;border:1px solid #ccd;border-radius:6px;padding:6px;',
    'font-size:13px;resize:vertical}',
    '.pop .row{display:flex;gap:6px;justify-content:flex-end}',
    '.pop button{all:unset;padding:5px 12px;border-radius:6px;cursor:pointer;font-size:13px;background:#eef;color:#113}',
    '.pop button.p{background:#2f7cf6;color:#fff}',
    '.panel{position:fixed;right:16px;bottom:62px;width:300px;max-height:60vh;overflow:auto;background:#fff;',
    'color:#111;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.25);padding:8px;font-size:13px}',
    '.panel .item{padding:6px;border-bottom:1px solid #eee;display:flex;gap:6px;align-items:flex-start}',
    '.panel .item:last-child{border-bottom:0}',
    '.panel .n{color:#2f7cf6;flex:0 0 auto}',
    '.panel .item.done .n{color:#7a8290}',
    '.panel .x{margin-left:auto;cursor:pointer;color:#a44;flex:0 0 auto}',
    '.style{position:fixed;right:16px;bottom:62px;width:220px;background:#fff;color:#111;border-radius:10px;',
    'box-shadow:0 8px 30px rgba(0,0,0,.25);padding:8px;font-size:13px;display:flex;flex-direction:column;gap:6px}',
    '.style label{display:flex;align-items:center;gap:6px}',
    '.style span{flex:0 0 52px;color:#556}',
    '.style input{flex:1;min-width:0;border:1px solid #ccd;border-radius:6px;padding:4px;font-size:13px}',
    '.edit{outline:2px solid #2f7cf6;border-radius:2px}',
    '.toast{position:fixed;right:16px;bottom:62px;max-width:320px;background:#111;color:#fff;',
    'padding:8px 12px;border-radius:8px;font-size:12.5px;line-height:1.5;',
    'box-shadow:0 8px 30px rgba(0,0,0,.3)}'
  ].join('');

  var style = document.createElement('style');
  style.textContent = CSS_TEXT;
  root.appendChild(style);

  var bar = document.createElement('div');
  bar.className = 'bar';
  root.appendChild(bar);

  var hl = document.createElement('div');
  hl.className = 'hl';
  hl.style.display = 'none';
  root.appendChild(hl);

  var layer = document.createElement('div');
  layer.style.cssText = 'position:absolute;left:0;top:0';
  root.appendChild(layer);

  var MODES = [
    { key: 'comment', label: '注釈' },
    { key: 'text', label: '文字' },
    { key: 'range', label: '範囲' },
    { key: 'style', label: '見た目' }
  ];
  var buttons = {};
  MODES.forEach(function (m) {
    var b = document.createElement('button');
    b.textContent = m.label;
    b.onclick = function () { setMode(mode === m.key ? null : m.key); };
    bar.appendChild(b);
    buttons[m.key] = b;
  });
  var listBtn = document.createElement('button');
  listBtn.onclick = function () { togglePanel(); };
  bar.appendChild(listBtn);

  // ---- 短い通知 ----
  var toastEl = null;
  var toastTimer = null;
  function toast(msg) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'toast';
      root.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.style.display = '';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.style.display = 'none'; }, 5000);
  }

  // ---- 通信 ----
  function post(name, body) {
    return fetch(API + name, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {})
    }).then(function (r) { return r.json(); });
  }

  function refresh() {
    return fetch(API + 'notes').then(function (r) { return r.json(); }).then(function (d) {
      notes = d.notes || [];
      var open = notes.filter(function (n) { return n.status !== 'done'; }).length;
      listBtn.textContent = '一覧' + (open ? ' ' + open : '');
      drawPins();
      if (panel) renderPanel();
    });
  }

  // ---- 要素の指し方 ----
  function selectorFor(el) {
    if (!el || el === document.body) return 'body';
    if (el.id) return '#' + CSS.escape(el.id);
    var parts = [];
    var cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.body) {
      var part = cur.tagName.toLowerCase();
      var parent = cur.parentElement;
      if (parent) {
        var same = Array.prototype.filter.call(parent.children, function (c) {
          return c.tagName === cur.tagName;
        });
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(cur) + 1) + ')';
      }
      parts.unshift(part);
      cur = parent;
    }
    return 'body > ' + parts.join(' > ');
  }

  function i18nKeyOf(el) {
    var cur = el;
    while (cur && cur.nodeType === 1) {
      if (cur.hasAttribute && cur.hasAttribute('data-i18n')) return cur.getAttribute('data-i18n');
      cur = cur.parentElement;
    }
    return null;
  }

  function langOf() {
    var p = location.pathname;
    if (p.indexOf('/jp/') >= 0) return 'ja';
    if (p.indexOf('/en/') >= 0) return 'en';
    var l = document.documentElement.lang || '';
    return l.indexOf('ja') === 0 ? 'ja' : 'en';
  }

  // クリック位置の Text ノードを取る（タグをまたがずに逆引きできるようにするため）
  function textNodeAt(x, y) {
    var pos = null;
    if (document.caretPositionFromPoint) pos = document.caretPositionFromPoint(x, y);
    if (pos && pos.offsetNode && pos.offsetNode.nodeType === 3) return pos.offsetNode;
    if (document.caretRangeFromPoint) {
      var r = document.caretRangeFromPoint(x, y);
      if (r && r.startContainer.nodeType === 3) return r.startContainer;
    }
    var el = document.elementFromPoint(x, y);
    if (!el) return null;
    for (var i = 0; i < el.childNodes.length; i++) {
      var n = el.childNodes[i];
      if (n.nodeType === 3 && n.data.trim()) return n;
    }
    return null;
  }

  function targetAt(e) {
    var el = document.elementFromPoint(e.clientX, e.clientY);
    return el && !host.contains(el) ? el : null;
  }

  // ---- モード ----
  function setMode(next) {
    mode = next;
    Object.keys(buttons).forEach(function (k) { buttons[k].classList.toggle('on', k === mode); });
    hl.style.display = 'none';
    if (styleBox) closeStyle();
    document.body.style.cursor = mode === 'range' ? 'crosshair' : '';
  }

  document.addEventListener('mousemove', function (e) {
    if (!mode || mode === 'range' || popup) { return; }
    var el = targetAt(e);
    if (!el) { hl.style.display = 'none'; return; }
    var r = el.getBoundingClientRect();
    hl.style.display = 'block';
    hl.style.left = r.left + 'px';
    hl.style.top = r.top + 'px';
    hl.style.width = r.width + 'px';
    hl.style.height = r.height + 'px';
  }, true);

  document.addEventListener('click', function (e) {
    if (!mode || mode === 'range') return;
    var el = targetAt(e);
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    if (mode === 'comment') openComment(el, e.clientX, e.clientY);
    else if (mode === 'text') startTextEdit(el, e.clientX, e.clientY);
    else if (mode === 'style') openStyle(el);
  }, true);

  // ---- 注釈 ----
  var popup = null;

  // layer は position:fixed の host の中なので、座標はビューポート基準で入れる。
  // クリック位置が画面の端でも入力欄が見切れないように収める
  function placePopup(box, x, y) {
    var w = 260, h = 120;
    box.style.left = Math.max(8, Math.min(x, window.innerWidth - w - 8)) + 'px';
    box.style.top = Math.max(8, Math.min(y + 8, window.innerHeight - h - 8)) + 'px';
  }
  function closePopup() {
    if (popup) { popup.remove(); popup = null; }
  }

  function openComment(el, x, y) {
    closePopup();
    var node = textNodeAt(x, y);
    var text = node ? node.data.replace(/\s+/g, ' ').trim() : (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    var box = document.createElement('div');
    box.className = 'pop';
    placePopup(box, x, y);
    var ta = document.createElement('textarea');
    ta.placeholder = 'コメント';
    var row = document.createElement('div');
    row.className = 'row';
    var cancel = document.createElement('button');
    cancel.textContent = 'やめる';
    cancel.onclick = closePopup;
    var ok = document.createElement('button');
    ok.className = 'p';
    ok.textContent = '追加';
    ok.onclick = function () {
      if (!ta.value.trim()) { closePopup(); return; }
      post('note', {
        kind: 'comment', page: location.pathname, selector: selectorFor(el),
        text: text, i18nKey: i18nKeyOf(el), comment: ta.value.trim()
      }).then(function () { closePopup(); refresh(); });
    };
    row.appendChild(cancel);
    row.appendChild(ok);
    box.appendChild(ta);
    box.appendChild(row);
    layer.appendChild(box);
    popup = box;
    ta.focus();
    ta.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) ok.click();
      if (ev.key === 'Escape') closePopup();
    });
  }

  // ---- 文字の直接書き換え ----
  function startTextEdit(el, x, y) {
    var node = textNodeAt(x, y);
    if (!node || !node.data.trim()) return;
    var original = node.data;
    var span = document.createElement('span');
    span.className = 'edit';
    span.contentEditable = 'true';
    span.textContent = original;
    node.parentNode.replaceChild(span, node);
    span.focus();
    var range = document.createRange();
    range.selectNodeContents(span);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    var closed = false;
    function finish(commit) {
      if (closed) return;
      closed = true;
      var next = span.textContent;
      var back = document.createTextNode(commit ? next : original);
      span.parentNode.replaceChild(back, span);
      if (!commit || next === original) return;
      post('edit', {
        page: location.pathname, selector: selectorFor(el), lang: langOf(),
        i18nKey: i18nKeyOf(el), oldText: original, newText: next
      }).then(function (res) {
        if (res.applied) {
          // 本番を写しているページでは、直したソースは画面に出てこない
          toast(res.files.join(', ') + ' を直しました'
            + (window.__webpinLive ? '（画面は ' + window.__webpinLive + ' のままです）' : ''));
        } else {
          toast('指摘として残しました（自動では直せない箇所です）');
        }
        return refresh();
      });
    }
    span.addEventListener('blur', function () { finish(true); });
    span.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); finish(true); }
      if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
    });
  }

  // ---- 範囲 ----
  var dragStart = null;
  var selBox = null;
  document.addEventListener('mousedown', function (e) {
    if (mode !== 'range') return;
    if (host.contains(e.target)) return;
    e.preventDefault();
    dragStart = { x: e.clientX, y: e.clientY };
    selBox = document.createElement('div');
    selBox.className = 'sel';
    root.appendChild(selBox);
  }, true);

  document.addEventListener('mousemove', function (e) {
    if (!dragStart || !selBox) return;
    var x = Math.min(dragStart.x, e.clientX), y = Math.min(dragStart.y, e.clientY);
    var w = Math.abs(e.clientX - dragStart.x), h = Math.abs(e.clientY - dragStart.y);
    selBox.style.left = x + 'px';
    selBox.style.top = y + 'px';
    selBox.style.width = w + 'px';
    selBox.style.height = h + 'px';
  }, true);

  document.addEventListener('mouseup', function (e) {
    if (!dragStart || !selBox) return;
    var rect = {
      x: Math.min(dragStart.x, e.clientX) + window.scrollX,
      y: Math.min(dragStart.y, e.clientY) + window.scrollY,
      width: Math.abs(e.clientX - dragStart.x),
      height: Math.abs(e.clientY - dragStart.y)
    };
    var viewRect = {
      left: Math.min(dragStart.x, e.clientX), top: Math.min(dragStart.y, e.clientY),
      right: Math.max(dragStart.x, e.clientX), bottom: Math.max(dragStart.y, e.clientY)
    };
    selBox.remove();
    selBox = null;
    dragStart = null;
    if (rect.width < 8 || rect.height < 8) return;
    captureRange(rect, viewRect, e.clientX, e.clientY);
  }, true);

  function insideOf(view) {
    var out = [];
    var all = document.body.querySelectorAll('*');
    for (var i = 0; i < all.length && out.length < 20; i++) {
      var el = all[i];
      if (host.contains(el)) continue;
      var r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      if (r.left >= view.left - 2 && r.right <= view.right + 2 &&
          r.top >= view.top - 2 && r.bottom <= view.bottom + 2) {
        var t = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40);
        out.push({ selector: selectorFor(el), text: t });
      }
    }
    return out;
  }

  function captureRange(rect, view, x, y) {
    var inside = insideOf(view);
    host.style.display = 'none';
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        post('shot', { page: location.pathname, rect: rect }).then(function (res) {
          host.style.display = '';
          openRangeComment(rect, inside, res && res.shot, x, y);
        }).catch(function () {
          host.style.display = '';
          openRangeComment(rect, inside, null, x, y);
        });
      });
    });
  }

  function openRangeComment(rect, inside, shotName, x, y) {
    closePopup();
    var box = document.createElement('div');
    box.className = 'pop';
    placePopup(box, x, y);
    var ta = document.createElement('textarea');
    ta.placeholder = 'コメント';
    var row = document.createElement('div');
    row.className = 'row';
    var cancel = document.createElement('button');
    cancel.textContent = 'やめる';
    cancel.onclick = closePopup;
    var ok = document.createElement('button');
    ok.className = 'p';
    ok.textContent = '追加';
    ok.onclick = function () {
      post('note', {
        kind: 'range', page: location.pathname, comment: ta.value.trim(),
        rect: rect, inside: inside, shot: shotName,
        selector: inside.length ? inside[0].selector : null,
        text: inside.length ? inside[0].text : null
      }).then(function () { closePopup(); refresh(); });
    };
    ta.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) ok.click();
    });
    row.appendChild(cancel);
    row.appendChild(ok);
    box.appendChild(ta);
    box.appendChild(row);
    layer.appendChild(box);
    popup = box;
    ta.focus();
  }

  // ---- 見た目 ----
  var styleBox = null;
  var styleTarget = null;
  var styleBefore = null;
  var STYLE_PROPS = [
    { prop: 'font-size', label: '文字' },
    { prop: 'padding', label: '内側' },
    { prop: 'margin', label: '外側' },
    { prop: 'color', label: '色' },
    { prop: 'background-color', label: '背景' }
  ];

  function closeStyle() {
    if (styleBox) { styleBox.remove(); styleBox = null; }
    styleTarget = null;
  }

  function openStyle(el) {
    closeStyle();
    styleTarget = el;
    var cs = getComputedStyle(el);
    styleBefore = {};
    styleBox = document.createElement('div');
    styleBox.className = 'style';
    STYLE_PROPS.forEach(function (p) {
      styleBefore[p.prop] = cs.getPropertyValue(p.prop).trim();
      var label = document.createElement('label');
      var span = document.createElement('span');
      span.textContent = p.label;
      var input = document.createElement('input');
      input.value = styleBefore[p.prop];
      input.oninput = function () { el.style.setProperty(p.prop, input.value); };
      label.appendChild(span);
      label.appendChild(input);
      styleBox.appendChild(label);
    });
    var row = document.createElement('div');
    row.className = 'row';
    row.style.cssText = 'display:flex;gap:6px;justify-content:flex-end';
    var cancel = document.createElement('button');
    cancel.textContent = '戻す';
    cancel.style.cssText = 'all:unset;padding:5px 12px;border-radius:6px;cursor:pointer;background:#eef;color:#113';
    cancel.onclick = function () { el.removeAttribute('style'); closeStyle(); };
    var ok = document.createElement('button');
    ok.textContent = '記録';
    ok.style.cssText = 'all:unset;padding:5px 12px;border-radius:6px;cursor:pointer;background:#2f7cf6;color:#fff';
    ok.onclick = function () {
      var changes = [];
      STYLE_PROPS.forEach(function (p) {
        var now = el.style.getPropertyValue(p.prop).trim();
        if (now && now !== styleBefore[p.prop]) {
          changes.push({ prop: p.prop, from: styleBefore[p.prop], to: now });
        }
      });
      if (!changes.length) { closeStyle(); return; }
      post('note', {
        kind: 'style', page: location.pathname, selector: selectorFor(el),
        text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60),
        style: changes,
        comment: changes.map(function (c) { return c.prop + ': ' + c.from + ' → ' + c.to; }).join(' / ')
      }).then(function () { closeStyle(); refresh(); });
    };
    row.appendChild(cancel);
    row.appendChild(ok);
    styleBox.appendChild(row);
    root.appendChild(styleBox);
  }

  // ---- ピン ----
  function drawPins() {
    Array.prototype.forEach.call(layer.querySelectorAll('.pin'), function (p) { p.remove(); });
    notes.filter(function (n) { return n.page === location.pathname && n.selector; }).forEach(function (n) {
      var el;
      try { el = document.querySelector(n.selector); } catch (e) { el = null; }
      if (!el) return;
      var r = el.getBoundingClientRect();
      var pin = document.createElement('div');
      pin.className = 'pin' + (n.status === 'done' ? ' done' : '');
      pin.textContent = n.id;
      pin.style.left = (r.left - 10) + 'px';
      pin.style.top = (r.top - 10) + 'px';
      pin.title = n.comment || '';
      pin.onclick = function () { togglePanel(true); };
      layer.appendChild(pin);
    });
  }

  // ---- 一覧 ----
  var panel = null;
  function togglePanel(force) {
    if (panel && !force) { panel.remove(); panel = null; return; }
    if (!panel) {
      panel = document.createElement('div');
      panel.className = 'panel';
      root.appendChild(panel);
    }
    renderPanel();
  }

  function renderPanel() {
    panel.textContent = '';
    notes.slice().reverse().forEach(function (n) {
      var item = document.createElement('div');
      item.className = 'item' + (n.status === 'done' ? ' done' : '');
      var num = document.createElement('span');
      num.className = 'n';
      num.textContent = n.id;
      var body = document.createElement('span');
      body.textContent = n.comment || n.text || '';
      var x = document.createElement('span');
      x.className = 'x';
      x.textContent = '×';
      x.onclick = function () { post('drop', { id: n.id }).then(refresh); };
      item.appendChild(num);
      item.appendChild(body);
      item.appendChild(x);
      panel.appendChild(item);
    });
  }

  // ---- サーバからの通知 ----
  var es = new EventSource(API + 'events');
  es.onmessage = function (ev) {
    if (ev.data === 'reload') {
      sessionStorage.setItem('__webpin_scroll', String(window.scrollY));
      location.reload();
    } else if (ev.data === 'notes') {
      refresh();
    }
  };

  var saved = sessionStorage.getItem('__webpin_scroll');
  if (saved !== null) {
    sessionStorage.removeItem('__webpin_scroll');
    window.scrollTo(0, Number(saved));
  }

  window.addEventListener('scroll', drawPins, { passive: true });
  window.addEventListener('resize', drawPins);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { closePopup(); setMode(null); }
  });

  refresh();
})();
