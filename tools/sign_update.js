#!/usr/bin/env node
// 签名更新清单：node tools/sign_update.js <version> <url> [sha256]
// 私钥路径：环境变量 DGO_UPDATE_KEY 或默认 ../update-signing/private.pem（相对本脚本）
// 输出：可直接发布的 update.json（含 sig）
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// 供 CI / 测试直接 require 调用
function signManifest(version, url, sha256, keyPath) {
  keyPath = keyPath || process.env.DGO_UPDATE_KEY || path.join(__dirname, '..', 'update-signing', 'private.pem');
  if (!fs.existsSync(keyPath)) throw new Error('找不到私钥: ' + keyPath);
  const j = { version, url, sha256: sha256 || '' };
  j.sig = crypto.sign(null, Buffer.from(`${version}|${url}|${j.sha256}`), fs.readFileSync(keyPath)).toString('base64');
  return j;
}

const [version, url, sha256] = process.argv.slice(2);
if (require.main === module && (!version || !url)) {
  console.error('用法: node tools/sign_update.js <version> <url> [sha256]');
  console.error('示例: node tools/sign_update.js 0.9.1 "https://github.com/me/DGO/releases/download/v0.9.1/DGO-Setup-0.9.1.exe" <安装包sha256>');
  process.exit(1);
}
if (require.main === module) console.log(JSON.stringify(signManifest(version, url, sha256), null, 2));
module.exports = { signManifest };
