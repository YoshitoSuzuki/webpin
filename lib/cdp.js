// Chrome DevTools Protocol を Node 標準ライブラリだけで叩く（WebSocket は必要な分だけ自前）
const net = require('net');
const http = require('http');
const crypto = require('crypto');

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    }).on('error', reject);
  });
}

function frame(text) {
  const data = Buffer.from(text, 'utf8');
  const mask = crypto.randomBytes(4);
  let header;
  if (data.length < 126) {
    header = Buffer.from([0x81, 0x80 | data.length]);
  } else if (data.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 0x80 | 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  const masked = Buffer.from(data);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const u = new URL(wsUrl);
    const sock = net.connect(Number(u.port), u.hostname, () => {
      const key = crypto.randomBytes(16).toString('base64');
      sock.write('GET ' + u.pathname + (u.search || '') + ' HTTP/1.1\r\n' +
        'Host: ' + u.host + '\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Key: ' + key + '\r\n' +
        'Sec-WebSocket-Version: 13\r\n\r\n');
    });

    let buf = Buffer.alloc(0);
    let frag = Buffer.alloc(0);
    let upgraded = false;
    let seq = 0;
    const pending = new Map();

    sock.on('error', reject);
    sock.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      if (!upgraded) {
        const end = buf.indexOf('\r\n\r\n');
        if (end === -1) return;
        upgraded = true;
        buf = buf.slice(end + 4);
        resolve({ send, close });
      }
      while (buf.length >= 2) {
        const fin = (buf[0] & 0x80) !== 0;
        const op = buf[0] & 0x0f;
        let len = buf[1] & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2); off = 4;
        } else if (len === 127) {
          if (buf.length < 10) return;
          len = Number(buf.readBigUInt64BE(2)); off = 10;
        }
        if (buf.length < off + len) return;
        const payload = buf.slice(off, off + len);
        buf = buf.slice(off + len);
        if (op === 0x8) { sock.end(); return; }
        if (op === 0x9) continue;
        if (op === 0x1 || op === 0x0) {
          frag = Buffer.concat([frag, payload]);
          if (!fin) continue;
          const text = frag.toString('utf8');
          frag = Buffer.alloc(0);
          let msg;
          try { msg = JSON.parse(text); } catch (e) { continue; }
          const p = pending.get(msg.id);
          if (p) {
            pending.delete(msg.id);
            msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
          }
        }
      }
    });

    function send(method, params) {
      const id = ++seq;
      return new Promise((res, rej) => {
        pending.set(id, { resolve: res, reject: rej });
        sock.write(frame(JSON.stringify({ id: id, method: method, params: params || {} })));
      });
    }
    function close() { try { sock.end(); } catch (e) { /* 既に閉じている */ } }
  });
}

// webpin が配信しているタブを探す
async function pageFor(cdpPort, serverPort) {
  const list = JSON.parse(await get('http://127.0.0.1:' + cdpPort + '/json/list'));
  const mine = list.filter(t => t.type === 'page' && t.url && t.url.includes(':' + serverPort + '/'));
  return (mine[0] || null);
}

module.exports = { connect, pageFor, get };
