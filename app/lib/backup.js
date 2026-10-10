// 数据安全包（#70 增长①）：设置/订阅一键导出导入（换机搬家）
// 迁移包 = JSON：settings（outDir/notify/AI 配置等）+ subs（含 known/lastSeen，增量比对不丢）。
// 不含：cookies（风控指纹敏感，跨机应重登）、转写模型（大文件，首次使用自动下载）、媒体文件本体。
// 导入策略：订阅按 URL 去重合并（已有的跳过），设置覆盖合并——绝不静默删除现有数据。
const fs = require('fs');

const BUNDLE_VERSION = 1;

// settings 恢复白名单（防导入包注入未知键）
const SETTINGS_KEYS = ['outDir', 'notifyDone', 'notifyMode', 'aiUrl', 'aiKey', 'aiModel', 'asrMirror'];

function buildBundle({ settings, subs }) {
  return {
    app: 'DGO', bundleVersion: BUNDLE_VERSION, at: new Date().toISOString(),
    settings, subs,
  };
}

// 导出：paths = { settingsFile, subsFile }；返回 { ok, bundle, counts } 或 { ok:false, reason }
function collect(paths) {
  try {
    const settings = JSON.parse(fs.readFileSync(paths.settingsFile, 'utf-8'));
    let subs = [];
    try { subs = JSON.parse(fs.readFileSync(paths.subsFile, 'utf-8')); } catch (e) {}
    if (!Array.isArray(subs)) subs = [];
    const bundle = buildBundle({
      settings: Object.fromEntries(SETTINGS_KEYS.filter(k => settings[k] !== undefined).map(k => [k, settings[k]])),
      subs: subs.map(s => {
        // 轻量化：known/goneSeen 是增量比对核心要带上；瞬时状态不带
        const { failStreak, ...rest } = s;
        return rest;
      }),
    });
    return { ok: true, bundle, counts: { subs: bundle.subs.length, settings: Object.keys(bundle.settings).length } };
  } catch (e) { return { ok: false, reason: '读取配置失败: ' + e.message }; }
}

// 导入：settingsSetter(patch) 写设置；subsAdd(url) 走正常添加流程（复用分类/命名）；返回摘要
async function apply(bundle, { settingsSetter, subsAdd, subsUrls }) {
  if (!bundle || bundle.app !== 'DGO' || !bundle.bundleVersion) return { ok: false, reason: '不是有效的 DGO 迁移包' };
  const out = { settingsApplied: 0, subsAdded: 0, subsSkipped: 0, errors: [] };
  // 1) 设置覆盖合并（只动白名单键）
  const s = bundle.settings || {};
  const patch = {};
  for (const k of SETTINGS_KEYS) if (s[k] !== undefined && s[k] !== null && s[k] !== '') patch[k] = s[k];
  if (Object.keys(patch).length) { settingsSetter(patch); out.settingsApplied = Object.keys(patch).length; }
  // 2) 订阅按 URL 合并（URL 已存在的跳过；导入包里的 URL 必须能被当前版本分类，失败的记 errors 不中断）
  const existing = new Set((subsUrls || []).map(u => String(u).trim()));
  for (const sub of (bundle.subs || [])) {
    const url = String(sub.url || '').trim();
    if (!url) continue;
    if (existing.has(url)) { out.subsSkipped++; continue; }
    const r = subsAdd(url, sub.name || undefined);
    if (r && r.ok) { out.subsAdded++; existing.add(url); }
    else out.errors.push((sub.name || url) + ': ' + ((r && r.reason) || '添加失败').slice(0, 60));
  }
  return { ok: true, ...out };
}

module.exports = { collect, apply, SETTINGS_KEYS };
