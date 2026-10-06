// プロジェクトの特定（git ルート）、ポート導出、キャッシュ置き場
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// サブディレクトリから叩いても同じプロジェクトに当たるよう git ルートまで遡る
function rootOf(startDir) {
  let dir = path.resolve(startDir);
  while (true) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return path.resolve(startDir);
    dir = up;
  }
}

function hashOf(root) {
  return crypto.createHash('sha1').update(root).digest('hex').slice(0, 10);
}

// md と同じく、パスから決定的にポートを決める（リロードしても URL が変わらない）
function portOf(root) {
  const n = parseInt(crypto.createHash('sha1').update(root).digest('hex').slice(0, 8), 16);
  return 49152 + (n % 10000);
}

function cacheDir(root) {
  return path.join(os.homedir(), '.cache', 'webpin', path.basename(root) + '-' + hashOf(root));
}

// プロジェクトごとの設定（いまはライブ中継先だけ）。
// リポジトリの中に置くと公開されてしまうのでキャッシュ側に持つ
function configFile(root) {
  return path.join(cacheDir(root), 'config.json');
}

function readConfig(root) {
  try { return JSON.parse(fs.readFileSync(configFile(root), 'utf8')); } catch (e) { return {}; }
}

function writeConfig(root, cfg) {
  fs.mkdirSync(cacheDir(root), { recursive: true });
  fs.writeFileSync(configFile(root), JSON.stringify(cfg, null, 2) + '\n');
}

module.exports = { rootOf, portOf, cacheDir, hashOf, readConfig, writeConfig };
