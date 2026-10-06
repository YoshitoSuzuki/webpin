// 範囲指定のスクリーンショット。実際に開いているタブをそのまま撮る。
const fs = require('fs');
const path = require('path');
const cdp = require('./cdp');
const store = require('./store');

async function capture(root, serverPort, rect) {
  const target = await cdp.pageFor(serverPort + 2, serverPort);
  if (!target) throw new Error('CDP のタブが見つからない');
  const conn = await cdp.connect(target.webSocketDebuggerUrl);
  try {
    const res = await conn.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: {
        x: Math.round(rect.x), y: Math.round(rect.y),
        width: Math.round(rect.width), height: Math.round(rect.height),
        scale: 1
      }
    });
    const dir = store.shotsDir(root);
    fs.mkdirSync(dir, { recursive: true });
    const name = Date.now() + '.png';
    fs.writeFileSync(path.join(dir, name), Buffer.from(res.data, 'base64'));
    return { name: name, path: path.join(dir, name) };
  } finally {
    conn.close();
  }
}

module.exports = { capture };
