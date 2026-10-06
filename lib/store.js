// 指摘の保存。追記専用の JSONL にして、サーバとスキルが同時に触っても壊れないようにする。
const fs = require('fs');
const path = require('path');
const { cacheDir } = require('./project');

function file(root) { return path.join(cacheDir(root), 'notes.jsonl'); }
function shotsDir(root) { return path.join(cacheDir(root), 'shots'); }

function append(root, record) {
  fs.mkdirSync(cacheDir(root), { recursive: true });
  fs.appendFileSync(file(root), JSON.stringify(record) + '\n');
}

function lines(root) {
  let raw;
  try { raw = fs.readFileSync(file(root), 'utf8'); } catch (e) { return []; }
  return raw.split('\n').filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch (e) { return null; }
  }).filter(Boolean);
}

// 追記されたレコードを畳んで、いまの状態を作る
function load(root) {
  const notes = new Map();
  for (const rec of lines(root)) {
    if (rec.type === 'note') notes.set(rec.id, Object.assign({ status: 'open' }, rec.note, { id: rec.id }));
    else if (rec.type === 'done' && notes.has(rec.id)) {
      Object.assign(notes.get(rec.id), { status: 'done', resolvedAt: rec.at, resolveNote: rec.note });
    } else if (rec.type === 'drop') notes.delete(rec.id);
  }
  return [...notes.values()];
}

function nextId(root) {
  let max = 0;
  for (const rec of lines(root)) if (rec.id > max) max = rec.id;
  return max + 1;
}

function add(root, note) {
  const id = nextId(root);
  const entry = Object.assign({ status: 'open', createdAt: new Date().toISOString() }, note);
  append(root, { type: 'note', id: id, note: entry });
  return Object.assign({ id: id }, entry);
}

function done(root, id, note) {
  const exists = load(root).some(n => n.id === Number(id));
  if (!exists) return false;
  append(root, { type: 'done', id: Number(id), at: new Date().toISOString(), note: note });
  return true;
}

function drop(root, id) {
  const exists = load(root).some(n => n.id === Number(id));
  if (!exists) return false;
  append(root, { type: 'drop', id: Number(id) });
  return true;
}

function clearDone(root) {
  for (const n of load(root)) if (n.status === 'done') drop(root, n.id);
}

module.exports = { load, add, done, drop, clearDone, shotsDir, file };
