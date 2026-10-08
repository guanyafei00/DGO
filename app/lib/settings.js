// 应用设置：userData/settings.json（当前仅 outDir，后续可扩展）
const fs = require('fs');
const path = require('path');
const { atomicWrite, readJson } = require('./jsonfile');

let FILE = null;
let data = {};

function configure({ file, defaultOutDir }) {
  FILE = file;
  data = readJson(FILE, {}, v => v && typeof v === 'object' && !Array.isArray(v));
  if (!data.outDir || typeof data.outDir !== 'string') data.outDir = defaultOutDir;
}

function get() { return { ...data }; }
function set(patch) {
  Object.assign(data, patch);
  try { atomicWrite(FILE, JSON.stringify(data, null, 2)); } catch (e) { console.warn('[settings] save fail:', e.message); }
  return get();
}
// 目录校验：存在/可创建/可写
function validateDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return { ok: true };
  } catch (e) { return { ok: false, reason: e.message }; }
}

module.exports = { configure, get, set, validateDir };
