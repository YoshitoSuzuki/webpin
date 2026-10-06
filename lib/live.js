// 本番サーバーへの中継。
// DB やセッションに依存する PHP ページはローカルの php -S では動かないので、
// 生きているサイトの応答をそのまま借りて表示する（オーバーレイだけ差し込む）。
const http = require('http');
const https = require('https');
const { URL } = require('url');

// dev プロキシとしては邪魔になるヘッダ。
// CSP は差し込んだ overlay.js を止めうるし、HSTS は localhost に残ると厄介
const DROP = [
  'content-security-policy', 'content-security-policy-report-only',
  'strict-transport-security', 'x-frame-options', 'content-encoding', 'content-length',
  'transfer-encoding', 'connection'
];

// Domain 指定と Secure を落として、localhost でもそのまま Cookie が通るようにする。
// これが無いとログインしてもセッションが維持できない
function localizeCookie(v) {
  return v.split(';').filter(p => {
    const k = p.trim().toLowerCase();
    return !k.startsWith('domain=') && k !== 'secure';
  }).map(p => (/^\s*samesite=none$/i.test(p) ? ' SameSite=Lax' : p)).join(';');
}

function forward(opts) {
  const { origin, req, res, body, inject } = opts;
  const up = new URL(origin);
  const mod = up.protocol === 'https:' ? https : http;
  const localOrigin = 'http://' + (req.headers.host || '127.0.0.1');

  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (['host', 'connection', 'content-length', 'accept-encoding'].includes(k)) continue;
    headers[k] = v;
  }
  headers.host = up.host;
  headers['accept-encoding'] = 'identity'; // 圧縮されると HTML に差し込めない
  // Origin / Referer を見る CSRF 対策に引っかからないよう本番のものに直す
  if (headers.origin) headers.origin = up.origin;
  if (headers.referer) headers.referer = headers.referer.split(localOrigin).join(up.origin);
  if (body && body.length) headers['content-length'] = Buffer.byteLength(body);

  const preq = mod.request({
    protocol: up.protocol, host: up.hostname,
    port: up.port || (up.protocol === 'https:' ? 443 : 80),
    path: req.url, method: req.method, headers: headers
  }, pres => {
    const out = {};
    for (const [k, v] of Object.entries(pres.headers)) {
      if (DROP.includes(k)) continue;
      out[k] = v;
    }
    if (pres.headers['set-cookie']) out['set-cookie'] = pres.headers['set-cookie'].map(localizeCookie);
    // 本番の絶対URLへ飛ばされるとプロキシの外に出てしまう
    if (out.location) out.location = String(out.location).split(up.origin).join(localOrigin);

    const type = pres.headers['content-type'] || '';
    if (!type.includes('text/html')) {
      if (pres.headers['content-length']) out['content-length'] = pres.headers['content-length'];
      res.writeHead(pres.statusCode, out);
      pres.pipe(res);
      return;
    }
    const chunks = [];
    pres.on('data', c => chunks.push(c));
    pres.on('end', () => {
      res.writeHead(pres.statusCode, out);
      res.end(inject(Buffer.concat(chunks).toString('utf8')));
    });
  });

  preq.on('error', e => {
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('ライブ中継に失敗: ' + origin + req.url + '\n' + (e && e.message));
  });
  if (body && body.length) preq.write(body);
  preq.end();
}

module.exports = { forward };
