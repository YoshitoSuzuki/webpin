// ローカル配信 + オーバーレイ注入 + 指摘の受け口
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const store = require('./store');
const resolveLib = require('./resolve');
const apply = require('./apply');
const shot = require('./shot');
const live = require('./live');

const WEB = path.join(__dirname, '..', 'web');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.ttf': 'font/ttf', '.mp4': 'video/mp4', '.pdf': 'application/pdf',
  '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8'
};

function inject(html, liveOrigin) {
  // ライブ中継のページは、ソースを直しても画面は本番のまま。
  // オーバーレイ側でそれを断れるように知らせる
  const tag = (liveOrigin ? '<script>window.__webpinLive=' + JSON.stringify(liveOrigin) + '</script>\n' : '')
    + '<script src="/__webpin/overlay.js"></script>\n';
  const i = html.toLowerCase().lastIndexOf('</body>');
  return i === -1 ? html + tag : html.slice(0, i) + tag + html.slice(i);
}

function hasPhp() {
  try {
    execFileSync('php', ['-v'], { stdio: 'pipe' });
    return true;
  } catch (e) {
    return false;
  }
}

function readBody(req) {
  return new Promise(resolve => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

function start(opts) {
  const dir = opts.dir;
  const port = opts.port;
  const phpPort = port + 1;
  const liveOrigin = opts.live || null;
  const clients = [];
  const injectHere = html => inject(html, liveOrigin);
  let php = null;

  // ライブ中継のときは PHP を本番が実行するので、手元の php -S は立てない
  if (!liveOrigin && hasPhp()) {
    php = spawn('php', ['-S', '127.0.0.1:' + phpPort, '-t', dir], { stdio: 'ignore' });
  }

  function broadcast(event) {
    for (const res of clients.slice()) {
      try { res.write('data: ' + event + '\n\n'); } catch (e) { /* 切れた接続 */ }
    }
  }

  // ---- ファイル変更でブラウザを再読み込み ----
  let timer = null;
  try {
    fs.watch(dir, { recursive: true }, (type, name) => {
      if (!name || name.startsWith('.git') || name.includes('node_modules')) return;
      clearTimeout(timer);
      timer = setTimeout(() => broadcast('reload'), 250);
    });
  } catch (e) { /* 監視できない環境では諦める */ }

  function proxyPhp(req, res, urlPath, body) {
    const preq = http.request({
      host: '127.0.0.1', port: phpPort, path: urlPath, method: req.method,
      headers: Object.assign({}, req.headers, { host: '127.0.0.1:' + phpPort })
    }, pres => {
      const type = pres.headers['content-type'] || '';
      if (!type.includes('text/html')) {
        res.writeHead(pres.statusCode, pres.headers);
        pres.pipe(res);
        return;
      }
      const chunks = [];
      pres.on('data', c => chunks.push(c));
      pres.on('end', () => {
        const out = injectHere(Buffer.concat(chunks).toString('utf8'));
        const headers = Object.assign({}, pres.headers);
        delete headers['content-length'];
        res.writeHead(pres.statusCode, headers);
        res.end(out);
      });
    });
    preq.on('error', () => {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('php not reachable');
    });
    if (body && body.length) preq.write(body);
    preq.end();
  }

  function toLive(req, res, body) {
    live.forward({ origin: liveOrigin, req: req, res: res, body: body, inject: injectHere });
  }

  function serveFile(res, abs) {
    const ext = path.extname(abs).toLowerCase();
    if (ext === '.html' || ext === '.htm') {
      const html = injectHere(fs.readFileSync(abs, 'utf8'));
      res.writeHead(200, { 'content-type': MIME[ext], 'cache-control': 'no-store' });
      res.end(html);
      return;
    }
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(abs).pipe(res);
  }

  function pageAbsOf(pageUrl) {
    let p = decodeURIComponent((pageUrl || '/').split('?')[0]);
    let abs = path.join(dir, p);
    if (p.endsWith('/')) {
      for (const name of ['index.html', 'index.php', 'index.htm']) {
        if (fs.existsSync(path.join(abs, name))) return path.join(abs, name);
      }
    }
    return abs;
  }

  const api = {
    async note(data) {
      const cands = resolveLib.candidates(dir, {
        text: data.text, i18nKey: data.i18nKey, pageAbs: pageAbsOf(data.page)
      });
      const entry = store.add(dir, {
        kind: data.kind || 'comment',
        page: data.page,
        selector: data.selector,
        text: data.text,
        i18nKey: data.i18nKey,
        comment: data.comment,
        rect: data.rect,
        inside: data.inside,
        style: data.style,
        shot: data.shot,
        candidates: cands.slice(0, 8)
      });
      return { id: entry.id, candidates: entry.candidates };
    },

    async edit(data) {
      const pageAbs = pageAbsOf(data.page);
      const lang = data.lang || 'ja';
      const cands = resolveLib.candidates(dir, {
        text: data.oldText, i18nKey: data.i18nKey, pageAbs: pageAbs
      });

      // data-i18n のページは、いま見えている言語のエントリを直す。
      // 英語を直したときはテンプレートの直書きも同じ英文なので一緒に直す。
      const targets = [];
      if (data.i18nKey) {
        const tr = cands.filter(c => c.rank === 100 && c.lang === lang);
        if (tr.length === 1) targets.push(tr[0]);
        if (lang === 'en') {
          const tpl = cands.filter(c => c.rank === 90);
          if (tpl.length === 1) targets.push(tpl[0]);
        }
      }
      if (!targets.length) {
        const sole = resolveLib.soleSource(cands);
        if (sole) targets.push(sole);
      }

      // 全部消すのは文字の入れ替えではなく構造の変更。要素ごと消すのかキーを空で残すのかは
      // 機械的に決められないので、必ず指摘として残す
      if (!data.newText.trim()) {
        const entry = store.add(dir, {
          kind: 'delete', page: data.page, selector: data.selector, text: data.oldText,
          i18nKey: data.i18nKey, lang: lang,
          comment: '「' + data.oldText + '」を消す',
          candidates: cands.slice(0, 8)
        });
        return { applied: false, id: entry.id, candidates: entry.candidates };
      }

      const asNote = reason => {
        const entry = store.add(dir, {
          kind: 'edit', page: data.page, selector: data.selector, text: data.oldText,
          i18nKey: data.i18nKey, lang: lang,
          comment: '「' + data.oldText + '」を「' + data.newText + '」に直す'
            + (reason ? '（自動適用できず: ' + reason + '）' : ''),
          candidates: cands.slice(0, 8)
        });
        return { applied: false, id: entry.id, reason: reason, candidates: entry.candidates };
      };

      if (!targets.length) return asNote(null);

      const applied = [];
      for (const t of targets) {
        const r = apply.editText(dir, t, data.oldText, data.newText);
        if (!r.ok) {
          if (!applied.length) return asNote(r.reason);
          break;
        }
        applied.push(r);
      }

      const built = [];
      for (const rel of new Set(applied.map(a => a.file))) {
        const b = apply.rebuild(dir, rel);
        if (b) built.push(b);
      }

      // もう一方の言語は機械的に置き換えず、訳し直しとして残す
      let followUp = null;
      if (data.i18nKey) {
        const other = lang === 'ja' ? 'en' : 'ja';
        const target = cands.find(c => c.rank === 100 && c.lang === other);
        if (target) {
          followUp = store.add(dir, {
            kind: 'translate', page: data.page, selector: data.selector,
            i18nKey: data.i18nKey, lang: other,
            comment: target.file + ' の ' + other + '.' + data.i18nKey
              + ' も合わせて直す（' + lang + ' を「' + data.newText + '」に変更した）',
            candidates: [target]
          }).id;
        }
      }

      store.add(dir, {
        kind: 'edit', status: 'applied', page: data.page, selector: data.selector,
        text: data.oldText, i18nKey: data.i18nKey, lang: lang,
        comment: '「' + data.oldText + '」→「' + data.newText + '」',
        applied: applied.map(a => ({ file: a.file, line: a.line })),
        built: built
      });

      return { applied: true, files: applied.map(a => a.file + ':' + a.line), built: built, followUp: followUp };
    },

    async shot(data) {
      const out = await shot.capture(dir, port, data.rect);
      return { shot: out.name, path: out.path };
    },

    async notes() {
      return { notes: store.load(dir) };
    },

    async done(data) {
      return { ok: store.done(dir, data.id, data.note) };
    },

    async drop(data) {
      return { ok: store.drop(dir, data.id) };
    }
  };

  const server = http.createServer(async (req, res) => {
    const urlPath = decodeURIComponent(req.url.split('?')[0]);

    if (urlPath === '/__webpin/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive'
      });
      res.write(': ok\n\n');
      clients.push(res);
      req.on('close', () => {
        const i = clients.indexOf(res);
        if (i >= 0) clients.splice(i, 1);
      });
      return;
    }

    if (urlPath === '/__webpin/overlay.js') {
      const abs = path.join(WEB, path.basename(urlPath));
      res.writeHead(200, { 'content-type': MIME[path.extname(abs)], 'cache-control': 'no-store' });
      res.end(fs.readFileSync(abs));
      return;
    }

    if (urlPath.startsWith('/__webpin/shots/')) {
      const abs = path.join(store.shotsDir(dir), path.basename(urlPath));
      if (!fs.existsSync(abs)) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': 'image/png' });
      fs.createReadStream(abs).pipe(res);
      return;
    }

    if (urlPath.startsWith('/__webpin/')) {
      const name = urlPath.slice('/__webpin/'.length);
      if (!api[name]) { json(res, 404, { error: 'unknown' }); return; }
      const raw = await readBody(req);
      let data = {};
      if (raw.length) {
        try { data = JSON.parse(raw.toString('utf8')); } catch (e) { data = {}; }
      }
      try {
        json(res, 200, await api[name](data));
      } catch (e) {
        json(res, 500, { error: String(e && e.message || e) });
      }
      if (name !== 'notes') broadcast('notes');
      return;
    }

    // ---- 通常のページ配信 ----
    // ライブ中継のときも、手元にある静的ファイル（CSS/JS/画像）はローカルを優先する。
    // 編集した結果をその場で見られるようにするため
    let abs = path.join(dir, urlPath);
    if (!abs.startsWith(dir)) { res.writeHead(403); res.end(); return; }

    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
      if (!urlPath.endsWith('/')) {
        res.writeHead(302, { location: urlPath + '/' });
        res.end();
        return;
      }
      const index = ['index.html', 'index.php', 'index.htm'].map(n => path.join(abs, n)).find(fs.existsSync);
      if (!index) {
        if (liveOrigin) { toLive(req, res, await readBody(req)); return; }
        res.writeHead(404); res.end('no index'); return;
      }
      abs = index;
    }

    if (abs.endsWith('.php')) {
      if (liveOrigin) { toLive(req, res, await readBody(req)); return; }
      if (!php) {
        res.writeHead(501, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('php not installed');
        return;
      }
      proxyPhp(req, res, req.url, await readBody(req));
      return;
    }

    if (!fs.existsSync(abs)) {
      if (liveOrigin) { toLive(req, res, await readBody(req)); return; }
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
      res.end(injectHere('<!doctype html><meta charset="utf-8"><title>404</title><body><p>404 ' + urlPath + '</p>'));
      return;
    }
    serveFile(res, abs);
  });

  server.listen(port, '127.0.0.1');

  function stop() {
    if (php) php.kill();
    server.close();
  }
  process.on('SIGINT', () => { stop(); process.exit(0); });
  process.on('SIGTERM', () => { stop(); process.exit(0); });

  return { server, stop, hasPhp: !!php, live: liveOrigin };
}

module.exports = { start };
