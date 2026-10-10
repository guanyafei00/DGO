// 图文动态增量链路串联验证（独立于 Electron）：
// 探针拉列表 → 删一条 known 模拟新增 → checkSub 发现增量 → 自动入队 → 下载 done
const path = require('path');
const fs = require('fs');

const APP = __dirname;
const BIN = path.join(APP, 'resources', 'bin');
const COOKIE = path.join(APP, 'resources', 'cookies.txt');
const TMP = path.join(APP, 'verify_tmp');
fs.mkdirSync(TMP, { recursive: true });

const strategy = require('./lib/strategy');
const { DownloadQueue, configure } = require('./lib/queue');
const subs = require('./lib/subs');

strategy.configure({ stateFile: path.join(TMP, 'site-state.json') });
configure({ binDir: BIN, cookiePath: COOKIE, outDir: path.join(TMP, 'dl') });
subs.configure({ binDir: BIN, cookiePath: COOKIE, file: path.join(TMP, 'subs.json') });

const queue = new DownloadQueue(() => {});
const UID = '946974';
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const t0 = Date.now();
  // 1. 订阅 + 首次检查（带重试直到探针给数据）
  const added = subs.add(`https://space.bilibili.com/${UID}`, 'verify-sub');
  const sub = subs.get(added.sub.id);
  let r1 = null;
  for (let i = 0; i < 5; i++) {
    try {
      r1 = await subs.checkSub(sub, () => {});
      if (r1.ok && r1.total > 0) break;
      console.log(`[verify] 探针第${i + 1}次: total=${r1.total ?? '?'}（空列表/冷却，45s 后重试）`);
    } catch (e) {
      console.log(`[verify] 探针第${i + 1}次异常: ${String(e.message).slice(0, 80)}（45s 后重试）`);
    }
    await wait(45000);
  }
  if (!r1 || !r1.ok || !r1.total) { console.log('VERIFY_FAIL: 探针持续被风控'); process.exit(1); }
  console.log(`[verify] ① 首检成功: total=${r1.total}（opus+video 混合列表）`);

  // 2. 模拟新增：删掉最新一条 known，保持非首检状态
  sub.checked = 1;
  sub.known = sub.known.slice(1);

  // 2. 模拟新增：挑一条「有媒体」的已知动态（video/opus），从 known 删除
  const mediaItems = (r1.items || []).filter(i => i.type === 'video' || i.type === 'opus');
  if (!mediaItems.length) { console.log('VERIFY_FAIL: 近期动态均无媒体'); process.exit(1); }
  const target = mediaItems[0];
  sub.checked = 1;
  sub.known = sub.known.filter(id => id !== target.id);
  console.log(`[verify] 模拟增量: 删除已知 ${target.type} ${target.id}`);

  // 3. 再检查 → 应发现 1 条新 → onNew 自动入队（空列表=风控软降级，重试）
  let dlItem = null, r2 = null;
  for (let i = 0; i < 5; i++) {
    r2 = await subs.checkSub(sub, (s, it) => {
      if (it.type === 'text' || it.id !== target.id) return;   // 只为目标条目触发下载
      dlItem = it;
      const engine = it.type === 'video' ? 'yt-dlp' : 'gallery-dl';
      console.log(`[verify] ② 发现增量: ${it.type} ${it.id} → 自动入队（${engine}）`);
      queue.add(subs.itemUrl(s, it), { engine, title: `[增量] ${it.type} ${it.id}` });
    });
    if (r2.ok && r2.total > 0) break;
    console.log(`[verify] r2 空列表（软降级），30s 后重试`);
    await wait(30000);
  }
  if (!r2 || !r2.fresh) { console.log('VERIFY_FAIL: 未发现模拟的增量'); process.exit(1); }
  if (!dlItem) { console.log('VERIFY_FAIL: 目标条目未触发入队'); process.exit(1); }

  // 4. 等下载终态
  const ok = await new Promise(resolve => {
    const iv = setInterval(() => {
      const s = queue.snapshot().filter(x => x.title.startsWith('[增量]'));
      if (s.length && s.every(x => ['done', 'error', 'canceled'].includes(x.status))) {
        clearInterval(iv);
        resolve({ allDone: s.every(x => x.status === 'done'), items: s });
      }
    }, 1500);
  });
  for (const it of ok.items) console.log(`[verify] ③ 下载任务: ${it.status} ${it.error || it.filePath || ''}`);
  const outDir = path.join(TMP, 'dl');
  const files = [];
  (function walk(d) { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); fs.statSync(p).isDirectory() ? walk(p) : files.push(p); } })(outDir);
  console.log('[verify] 产物:', files.map(f => `${path.relative(outDir, f)}(${(fs.statSync(f).size / 1e3).toFixed(0)}KB)`).join(', ') || '无');

  console.log(ok.allDone && files.length ? `VERIFY_PASS (${((Date.now() - t0) / 1000).toFixed(0)}s)` : 'VERIFY_FAIL');
  process.exit(ok.allDone && files.length ? 0 : 1);
})();
