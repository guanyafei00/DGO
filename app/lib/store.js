// JSON 持久化：任务队列重启恢复 + 站点档位（策略层自持久化）
const fs = require('fs');
const path = require('path');
const { atomicWrite, readJson } = require('./jsonfile');

let tasksPath = null;
let _saveTimer = null;
let _pendingItems = null;
function configure({ userData }) {
  tasksPath = path.join(userData, 'tasks.json');
}
function load() {
  // 必须是数组：损坏/类型不对时坏文件已被隔离为 .bad-*，返回空并让 save 重建
  return readJson(tasksPath, [], Array.isArray);
}
// 1s 防抖（会审 P2）：下载高峰每次进度推送都全量同步写盘太重；flushNow 在退出前强制落盘
function save(items) {
  _pendingItems = items;
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => { _saveTimer = null; flushNow(); }, 1000);
}
function flushNow() {
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
  if (_pendingItems === null || !tasksPath) return;
  const items = _pendingItems;
  _pendingItems = null;
  try {
    atomicWrite(tasksPath, JSON.stringify(items.map(({ _child, _wasActive, ...rest }) => rest)));
  } catch (e) { console.warn('[store] save fail:', e.message); }
}

module.exports = { configure, load, save, flushNow };
