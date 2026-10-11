// 引擎自更新：风控对抗第一道防线——上游社区（yt-dlp/gallery-dl）每天在更新对抗规则，
// 我们只负责保持引擎最新。 yt-dlp: GitHub latest（重定向法绕 API 限流）
//                    gallery-dl: Codeberg API（不限流）
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');

let BIN = null;          // 可写引擎目录（userData/engines）：更新落这里（外部会审 deepseek #9 变体：装到 Program Files 时 resources/bin 只读）
let FALLBACK_BIN = null; // 随包目录（resources/bin）：本地版本探测的回退位
function configure({ binDir, fallbackBinDir }) { BIN = binDir; FALLBACK_BIN = fallbackBinDir || null; }

// 通用超时 GET（会审 P2：GitHub 半开连接不再让检查永久挂死）
function getWithTimeout(url, headers, handler, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, res => {
      try { handler(res, resolve, reject); } catch (e) { reject(e); }
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
  });
}
function getRedirect(url) {
  return getWithTimeout(url, { 'User-Agent': 'Mozilla/5.0' }, (res, resolve, reject) => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) resolve(res.headers.location);
    else { res.resume(); reject(new Error('no redirect: ' + res.statusCode)); }
  });
}
function getJson(url) {
  return getWithTimeout(url, { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }, (res, resolve, reject) => {
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
  });
}
function getText(url) {
  return getWithTimeout(url, { 'User-Agent': 'Mozilla/5.0' }, (res, resolve, reject) => {
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => resolve(d));
  });
}
function download(url, dest) {
  return new Promise((resolve, reject) => {
    const get = (u, redirects = 0) => {
      if (redirects > 5) return reject(new Error('too many redirects'));
      https.get(u, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
        res.on('error', reject);   // 网络半途断开不再变未捕获异常（会审修复）
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
          return get(res.headers.location, redirects + 1);
        if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
        const f = fs.createWriteStream(dest);
        res.pipe(f);
        f.on('finish', () => f.close(() => resolve(dest)));
        f.on('error', reject);
      }).on('error', reject);
    };
    get(url);
  });
}

// 引擎更新白名单（会审 P0 修复）：engine 只许这两个文件名，URL 只许官方发布域名——
// 堵死 renderer 被攻破后借 applyUpdate 任意下载/任意路径写 exe 的口子
const ENGINE_ALLOW = {
  'yt-dlp.exe': /^https:\/\/github\.com\/yt-dlp\/yt-dlp\/releases\/download\//,
  'gallery-dl.exe': /^https:\/\/codeberg\.org\/mikf\/gallery-dl\/releases\/download\//
};

async function latestYtDlp() {
  const loc = await getRedirect('https://github.com/yt-dlp/yt-dlp/releases/latest');
  const tag = (loc.match(/tag\/(.+?)(?:\?|$)/) || [])[1];
  return { version: tag, url: `https://github.com/yt-dlp/yt-dlp/releases/download/${tag}/yt-dlp.exe` };
}
async function latestGalleryDl() {
  // 会审 T1：releases/latest 可能只有源码资产（v1.32.16 实测无二进制，旧逻辑返回的 URL 404）。
  // 改为扫描最近 10 个 release，找最近一个带 gallery-dl.exe 的（与 engines_boot.gdlTag 同策略）
  const list = await getJson('https://codeberg.org/api/v1/repos/mikf/gallery-dl/releases?limit=10');
  for (const rel of (Array.isArray(list) ? list : [])) {
    const asset = (rel.assets || []).find(a => a.name === 'gallery-dl.exe');
    if (asset) return { version: rel.tag_name, url: asset.browser_download_url };
  }
  throw new Error('codeberg 最近 10 个 release 均无 gallery-dl.exe');
}
function localVersion(engine) {
  return new Promise(resolve => {
    // 主目录优先（自更新新版），回退随包目录（首装未更新时 bundled 版也算本地版本）
    const exe = fs.existsSync(path.join(BIN, engine)) ? path.join(BIN, engine)
      : (FALLBACK_BIN && fs.existsSync(path.join(FALLBACK_BIN, engine)) ? path.join(FALLBACK_BIN, engine) : path.join(BIN, engine));
    if (!fs.existsSync(exe)) return resolve(null);
    const child = spawn(exe, ['--version'], { windowsHide: true });
    let out = '';
    child.stdout.on('data', d => out += d);
    child.on('error', () => resolve(null));
    child.on('close', () => resolve((out.trim().split('\n')[0] || '').replace(/^v/, '')));
  });
}

// 检查全部引擎，返回 [{engine, local, remote, url, needUpdate}]
async function checkAll() {
  const [yLocal, gLocal, yRemote, gRemote] = await Promise.all([
    localVersion('yt-dlp.exe'), localVersion('gallery-dl.exe'),
    latestYtDlp().catch(() => null), latestGalleryDl().catch(() => null)
  ]);
  const out = [];
  if (yRemote) out.push({ engine: 'yt-dlp.exe', local: yLocal, remote: yRemote.version, url: yRemote.url, needUpdate: yLocal !== yRemote.version.replace(/^v/, '') });
  if (gRemote) out.push({ engine: 'gallery-dl.exe', local: gLocal, remote: gRemote.version, url: gRemote.url, needUpdate: gLocal !== gRemote.version.replace(/^v/, '') });
  return out;
}

// 流式 sha256（外部会审 deepseek #10：大文件不再整包读进内存）
function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(file);
    s.on('data', d => h.update(d));
    s.on('error', reject);
    s.on('end', () => resolve(h.digest('hex')));
  });
}
// yt-dlp 官方 SHA2-256SUMS 里抽 yt-dlp.exe 行的哈希（无官方哈希的引擎返回 null，调用方降级为仅 allowlist+HTTPS）
function parseEngineSha(sumsText, engine) {
  const line = String(sumsText || '').split(/\r?\n/).find(l => l.trim().endsWith(engine));
  if (!line) return null;
  const m = /^([0-9a-fA-F]{64})\s+/.exec(line.trim());
  return m ? m[1].toLowerCase() : null;
}
// 从 release 下载 URL 推同 tag 的校验和文件 URL（仅 yt-dlp 官方发布 SHA2-256SUMS）
function sumsUrlFor(engine, url) {
  if (engine !== 'yt-dlp.exe') return null;
  const m = /releases\/download\/([^/]+)\//.exec(url);
  return m ? 'https://github.com/yt-dlp/yt-dlp/releases/download/' + m[1] + '/SHA2-256SUMS' : null;
}

// 更新单个引擎：下载 temp → 校验（大小+SHA-256 可得时）→ 备份旧版 → 替换。必须在队列空闲时调用
async function updateEngine(engine, url) {
  const allowRe = ENGINE_ALLOW[engine];
  if (!allowRe) throw new Error('unknown engine: ' + engine);
  if (typeof url !== 'string' || !allowRe.test(url)) throw new Error('update url not allowed');
  const exe = path.join(BIN, engine);
  const tmp = exe + '.new';
  const bak = exe + '.bak';
  await download(url, tmp);
  const size = fs.existsSync(tmp) ? fs.statSync(tmp).size : 0;
  if (size < 1_000_000) { try { fs.unlinkSync(tmp); } catch (e) {} throw new Error('downloaded file too small: ' + size); }
  // SHA-256 校验（外部会审 deepseek #4）：引擎是被 spawn 的可执行文件，官方提供校验和就必须验
  let hashChecked = false;
  const sumsUrl = sumsUrlFor(engine, url);
  if (sumsUrl) {
    const sumsText = await getText(sumsUrl).catch(() => null);
    const expect = sumsText ? parseEngineSha(sumsText, engine) : null;
    if (expect) {
      const got = await sha256File(tmp);
      if (got !== expect) {
        try { fs.unlinkSync(tmp); } catch (e) {}
        throw new Error('SHA-256 校验失败（期望 ' + expect.slice(0, 12) + '…，实得 ' + got.slice(0, 12) + '…），已丢弃下载');
      }
      hashChecked = true;
    }
  }
  if (fs.existsSync(exe)) fs.copyFileSync(exe, bak);
  try {
    if (fs.existsSync(exe)) fs.unlinkSync(exe);
    fs.renameSync(tmp, exe);
  } catch (e) {
    // 替换失败必须回滚旧版（会审 P1：先前 unlink 后 rename 失败会让引擎目录损坏）
    try { if (!fs.existsSync(exe) && fs.existsSync(bak)) fs.copyFileSync(bak, exe); } catch (e2) {}
    try { fs.unlinkSync(tmp); } catch (e2) {}
    throw e;
  }
  const v = await localVersion(engine);
  return { engine, newVersion: v, backup: bak, hashChecked, installDir: BIN };
}

module.exports = { configure, checkAll, updateEngine, localVersion, getJsonPublic: getJson, downloadPublic: download, sha256File, parseEngineSha, sumsUrlFor };
