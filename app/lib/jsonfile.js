// JSON 安全持久化（会审 P0 修复）：
//  - atomicWrite: tmp + rename 原子替换，写一半断电不再产生半截文件
//  - readJson: 类型校验；损坏文件改名 .bad-<ts> 隔离现场，绝不静默覆盖
const fs = require('fs');

function atomicWrite(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, data);
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    // Windows 目标被占用等极端情况：退化为 copy，仍不落半截内容
    fs.copyFileSync(tmp, file);
    try { fs.unlinkSync(tmp); } catch (e2) {}
  }
}

function readJson(file, fallback, validate) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (validate && !validate(v)) throw new Error('type check failed');
    return v;
  } catch (e) {
    try {
      if (fs.existsSync(file)) fs.renameSync(file, file + '.bad-' + Date.now());
    } catch (e2) {}
    return typeof fallback === 'function' ? fallback() : fallback;
  }
}

module.exports = { atomicWrite, readJson };
