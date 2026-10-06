// 逆引き: ブラウザで見えているテキスト → 編集すべきソースの file:line
const fs = require('fs');
const path = require('path');

const TEXT_EXT = new Set(['.html', '.htm', '.php', '.js', '.json', '.md', '.css', '.txt']);
const SKIP_DIR = new Set(['.git', 'node_modules', '.cache', 'katex', 'build']);
const MAX_BYTES = 1024 * 1024;

function walk(dir, out, root) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || SKIP_DIR.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out, root);
    else if (TEXT_EXT.has(path.extname(e.name).toLowerCase())) out.push(full);
  }
  return out;
}

// そのファイルを吐いている build.js があるディレクトリ（無ければ null）
function buildDirFor(projectDir, absPath) {
  let dir = path.dirname(absPath);
  while (dir.startsWith(projectDir)) {
    if (fs.existsSync(path.join(dir, 'build.js'))) return dir;
    if (dir === projectDir) break;
    dir = path.dirname(dir);
  }
  return null;
}

// build.js 配下の .html は生成物とみなす。ただしテンプレートを持つ build.js に限る
// （アセットをコピーするだけの build.js の配下を巻き込まないため）
function hasTemplate(dir) {
  try {
    return fs.readdirSync(dir).some(n => n.startsWith('template_') && n.endsWith('.html'));
  } catch (e) {
    return false;
  }
}

function isGenerated(projectDir, absPath) {
  const ext = path.extname(absPath).toLowerCase();
  if (ext !== '.html' && ext !== '.htm') return false;
  if (path.basename(absPath).startsWith('template_')) return false;
  const dir = buildDirFor(projectDir, absPath);
  return dir !== null && hasTemplate(dir);
}

function score(projectDir, absPath) {
  const base = path.basename(absPath);
  const ext = path.extname(absPath).toLowerCase();
  if (isGenerated(projectDir, absPath)) return 5;
  if (base.startsWith('template_')) return 50;
  if (ext === '.json') return 60;
  if (ext === '.md') return 60;
  if (ext === '.js') return 55;
  if (ext === '.html' || ext === '.htm') return 45;
  if (ext === '.php') return 40;
  if (ext === '.css') return 10;
  return 20;
}

// 表示中のページに近い場所にあるソースを優先する
function proximity(pageAbs, absPath) {
  if (!pageAbs) return 0;
  const a = path.dirname(pageAbs).split(path.sep);
  const b = path.dirname(absPath).split(path.sep);
  let same = 0;
  while (same < a.length && same < b.length && a[same] === b[same]) same++;
  return Math.min(same, 12);
}

// 短すぎる文字列は同じものが各所にあるので自動適用しない
function longEnough(text) {
  const t = text.replace(/\s+/g, ' ').trim();
  if (/[\u3000-\u9fff\uff00-\uffef]/.test(t)) return t.length >= 4;
  return t.length >= 8;
}

function lineOf(content, index) {
  return content.slice(0, index).split('\n').length;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 空白の入り方がソースと違っても当たるようにする
function needleRe(text) {
  const parts = text.split(/\s+/).filter(Boolean).map(escapeRe);
  if (!parts.length) return null;
  return new RegExp(parts.join('\\s+'), 'g');
}

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };

function findInFile(absPath, text) {
  let content;
  try {
    const st = fs.statSync(absPath);
    if (st.size > MAX_BYTES) return null;
    content = fs.readFileSync(absPath, 'utf8');
  } catch (e) {
    return null;
  }
  for (const variant of [text, text.replace(/[&<>]/g, c => ENTITIES[c])]) {
    const re = needleRe(variant);
    if (!re) continue;
    const hits = [];
    let m;
    while ((m = re.exec(content)) !== null) {
      hits.push({ line: lineOf(content, m.index), matched: m[0] });
      if (hits.length > 5) break;
    }
    if (hits.length) return { content, hits };
  }
  return null;
}

// translations.js のどの言語ブロックの中か
function langAt(content, index) {
  const re = /^\s*"([a-z]{2})"\s*:\s*\{/gm;
  let lang = null;
  let m;
  while ((m = re.exec(content)) !== null) {
    if (m.index > index) break;
    lang = m[1];
  }
  return lang;
}

// data-i18n のキーから translations.js / template_*.html の該当行を直接引く
function byI18nKey(projectDir, files, key, pageAbs) {
  const owner = pageAbs ? buildDirFor(projectDir, pageAbs) : null;
  const out = [];
  const keyRe = new RegExp('"' + escapeRe(key) + '"\\s*:', 'g');
  const attrRe = new RegExp('data-i18n\\s*=\\s*"' + escapeRe(key) + '"', 'g');
  for (const abs of files) {
    if (owner && !abs.startsWith(owner + path.sep)) continue;
    const base = path.basename(abs);
    const isTr = base === 'translations.js';
    const isTpl = base.startsWith('template_');
    if (!isTr && !isTpl) continue;
    let content;
    try {
      content = fs.readFileSync(abs, 'utf8');
    } catch (e) {
      continue;
    }
    const re = isTr ? keyRe : attrRe;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(content)) !== null) {
      const lang = isTr ? langAt(content, m.index) : 'en';
      out.push({
        file: path.relative(projectDir, abs),
        line: lineOf(content, m.index),
        lang: lang,
        why: isTr ? 'translations の ' + lang + '.' + key : 'テンプレートの data-i18n=' + key + '（英語の直書き）',
        rank: isTr ? 100 : 90,
        generated: false
      });
    }
  }
  return out;
}

// text: ブラウザ上のテキスト / i18nKey: 要素の data-i18n / pageAbs: 表示中ページの実ファイル
function candidates(projectDir, { text, i18nKey, pageAbs }) {
  const files = walk(projectDir, [], projectDir);
  let out = [];
  if (i18nKey) out = out.concat(byI18nKey(projectDir, files, i18nKey, pageAbs));

  const needle = (text || '').replace(/\s+/g, ' ').trim();
  if (needle.length >= 2) {
    for (const abs of files) {
      const found = findInFile(abs, needle);
      if (!found) continue;
      const gen = isGenerated(projectDir, abs);
      for (const hit of found.hits) {
        out.push({
          file: path.relative(projectDir, abs),
          line: hit.line,
          why: gen ? '生成物（build.js が出力）' : 'テキスト一致',
          rank: score(projectDir, abs) + (gen ? 0 : proximity(pageAbs, abs)),
          generated: gen
        });
      }
    }
  }
  out.sort((a, b) => b.rank - a.rank || a.file.localeCompare(b.file));
  return out;
}

// 自動で書き換えてよいのは、生成物でないソースにちょうど1箇所だけ当たったとき
function soleSource(list) {
  const real = list.filter(c => !c.generated && c.rank >= 40);
  if (real.length > 1) {
    const top = real[0].rank;
    const tied = real.filter(c => c.rank === top);
    if (tied.length === 1) return tied[0];
  }
  const files = new Set(real.map(c => c.file + ':' + c.line));
  return files.size === 1 ? real[0] : null;
}

module.exports = { candidates, soleSource, isGenerated, buildDirFor, walk, needleRe, escapeRe, longEnough };
