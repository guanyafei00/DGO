// 更新清单验签（门槛③：更新通道必须验签——无人在环的自动安装通道，被劫持=静默 RCE）
// 清单格式：{"version":"x.y.z","url":"https://...","sha256":"(可选)","notes":"更新内容(可选)","page":"发布页链接(可选)","sig":"base64"}
// 待签名原文（canonical）：`${version}|${url}|${sha256||''}|${notes||''}|${page||''}`
// notes/page 也进签名（2026-10-10）：更新内容会被渲染层展示，不签名=可被篡改成钓鱼文本。
// 注意：此 canonical 变更后 v0.1.0 老清单验签将失败——私有仓库期软件内下载本就不可用，全体走 GitHub 手动升级，可接受
// 私钥保管在作者本地 update-signing/private.pem，永不进仓库/安装包
const crypto = require('crypto');

const PUB = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAvt9hm9nscwiEj61YWnTtKMvINgqoUVcsd9zp46ngFo4=
-----END PUBLIC KEY-----`;

function canonical(j) {
  return `${j.version}|${j.url}|${j.sha256 || ''}|${j.notes || ''}|${j.page || ''}`;
}

// 验签失败（含缺 sig）一律返回 false → 调用方必须拒绝更新
function verify(j) {
  try {
    if (!j || !j.version || !j.url || !j.sig) return false;
    return crypto.verify(null, Buffer.from(canonical(j)), PUB, Buffer.from(j.sig, 'base64'));
  } catch (e) { return false; }
}

// 安装包哈希校验（清单里带 sha256 时强制比对；缺失即拒绝，fail-closed）
// 外部改流式，110MB 安装包不再整包读进内存
async function sha256ok(filePath, expect) {
  try {
    if (!expect) return false;
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(filePath);
    const done = new Promise((resolve, reject) => {
      s.on('data', d => h.update(d));
      s.on('error', reject);
      s.on('end', () => resolve(h.digest('hex')));
    });
    const hex = await done;
    return hex.toLowerCase() === String(expect).toLowerCase();
  } catch (e) { return false; }
}

const fs = require('fs');
module.exports = { verify, sha256ok, canonical };
