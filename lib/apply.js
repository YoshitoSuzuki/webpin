// ソースの書き換えと build.js の再実行。
// 自動で書き換えるのは「そこがプレーンな文字列だと確かめられたとき」だけ。
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { needleRe, buildDirFor, longEnough } = require('./resolve');

// 一致箇所が素直な文字列の中にあるか確かめる
function contextOf(absPath, content, start, end) {
  const ext = path.extname(absPath).toLowerCase();
  const matched = content.slice(start, end);

  if (ext === '.md' || ext === '.txt') return { ok: true };

  if (ext === '.html' || ext === '.htm' || ext === '.php') {
    if (/[<>]/.test(matched)) return { ok: false, reason: 'タグをまたいでいる' };
    const before = content.slice(0, start).replace(/\s+$/, '');
    const after = content.slice(end).replace(/^\s+/, '');
    if (!before.endsWith('>')) return { ok: false, reason: 'タグの外に出ている' };
    if (!after.startsWith('<')) return { ok: false, reason: 'タグの外に出ている' };
    return { ok: true };
  }

  if (ext === '.js' || ext === '.json') {
    if (matched.includes('\\')) return { ok: false, reason: 'エスケープを含む' };
    if (ext === '.js' && matched.includes('${')) return { ok: false, reason: 'テンプレートリテラルの式を含む' };
    const line = content.slice(content.lastIndexOf('\n', start) + 1, start);
    const quotes = ext === '.json' ? ['"'] : ['"', "'", '`'];
    let quote = null;
    for (let i = line.length - 1; i >= 0; i--) {
      if (quotes.includes(line[i]) && line[i - 1] !== '\\') { quote = line[i]; break; }
    }
    if (!quote) return { ok: false, reason: '文字列リテラルの中ではない' };
    if (matched.includes(quote)) return { ok: false, reason: '囲みのクォートを含む' };
    return { ok: true, quote: quote };
  }

  return { ok: false, reason: '対象外のファイル形式' };
}

// 書き込む先の形式に合わせて新しいテキストを整える
function encodeFor(absPath, quote, text) {
  const ext = path.extname(absPath).toLowerCase();
  if (ext === '.html' || ext === '.htm' || ext === '.php') {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  if (ext === '.js' || ext === '.json') {
    let out = text.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
    if (quote) out = out.split(quote).join('\\' + quote);
    if (ext === '.js' && quote === '`') out = out.split('${').join('\\${');
    return out;
  }
  return text;
}

function editText(projectDir, candidate, oldText, newText) {
  if (!longEnough(oldText)) return { ok: false, reason: '短すぎて場所を特定できない' };

  const abs = path.join(projectDir, candidate.file);
  const content = fs.readFileSync(abs, 'utf8');
  const re = needleRe(oldText.replace(/\s+/g, ' ').trim());
  if (!re) return { ok: false, reason: '空のテキスト' };

  const hits = [];
  let m;
  while ((m = re.exec(content)) !== null) hits.push({ start: m.index, end: m.index + m[0].length });
  if (!hits.length) return { ok: false, reason: 'ソースに一致する箇所が無い' };
  if (hits.length > 1) return { ok: false, reason: '同じファイル内に同じ文字列が複数ある' };

  const hit = hits[0];
  const ctx = contextOf(abs, content, hit.start, hit.end);
  if (!ctx.ok) return { ok: false, reason: ctx.reason };

  const encoded = encodeFor(abs, ctx.quote, newText);
  fs.writeFileSync(abs, content.slice(0, hit.start) + encoded + content.slice(hit.end));
  return {
    ok: true,
    file: candidate.file,
    line: content.slice(0, hit.start).split('\n').length,
    before: content.slice(hit.start, hit.end)
  };
}

// 書き換えたファイルを吐いている build.js があれば回す（相対パス読みがあるので cwd 指定は必須）
function rebuild(projectDir, relFile) {
  const dir = buildDirFor(projectDir, path.join(projectDir, relFile));
  if (!dir) return null;
  try {
    execFileSync('node', ['build.js'], { cwd: dir, stdio: 'pipe' });
    return path.relative(projectDir, dir) || '.';
  } catch (e) {
    return { error: String((e.stderr && e.stderr.toString()) || e.message).slice(0, 400) };
  }
}

module.exports = { editText, rebuild, contextOf, encodeFor };
