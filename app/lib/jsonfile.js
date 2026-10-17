// JSON 安全持久化（
//  - atomicWrite: tmp + rename 原子替换，写一半断电不再产生半截文件
//  - readJson: 类型校验；损坏文件改名 .bad-<ts> 隔离现场，绝不静默覆盖
//
// 外部加固：Windows 下 rename 目标被杀软/读取器瞬时占用时，
// 旧版直接退化为 copyFileSync——目标文件在拷贝期间存在半截窗口。
// 现在改为：① rename 短重试（真实 sleep，等瞬时锁释放）② copy 到第二 tmp 后再 rename
// （最终切换仍原子）③ 全部失败才退化为直接 copy（内容完整但不原子，与旧版行为一致）。
const fs = require('fs');

// 同步上下文里的真实 sleep（主线程不能用 setTimeout 等待）；不可用时退化为忙等
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); return; } catch (e) {}
  const end = Date.now() + ms;
  while (Date.now() < end) { /* spin */ }
}

function atomicWrite(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, data);
  let lastErr = null;
  for (let i = 0; i < 3; i++) {
    try { fs.renameSync(tmp, file); return; } catch (e) { lastErr = e; if (i < 2) sleepSync(40 * (i + 1)); }
  }
  try {
    // 第二 tmp：拷贝完整内容，再 rename 完成原子切换（copy 本身不原子，但 rename 是）
    const tmp2 = file + '.tmp2';
    fs.copyFileSync(tmp, tmp2);
    for (let i = 0; i < 3; i++) {
      try { fs.renameSync(tmp2, file); try { fs.unlinkSync(tmp); } catch (e2) {} return; }
      catch (e) { lastErr = e; if (i < 2) sleepSync(40 * (i + 1)); }
    }
    // 终极兜底：直接 copy（内容已确认完整写完 tmp 再拷出，半截风险窗口极小）
    fs.copyFileSync(tmp2, file);
    try { fs.unlinkSync(tmp2); } catch (e2) {}
    try { fs.unlinkSync(tmp); } catch (e2) {}
  } catch (e) {
    throw lastErr || e;
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
