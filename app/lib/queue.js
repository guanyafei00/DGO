// 下载队列：并发控制 + 自适应风控（档位退避/站点熔断）+ 事件推送
const { spawn } = require('child_process');
const path = require('path');

// 平台化引擎文件名：win 加 .exe，mac/linux 裸名
function exe(n) { return process.platform === 'win32' ? n + '.exe' : n; }
const fs = require('fs');
const strategy = require('./strategy');

let BIN = path.join(__dirname, '..', 'resources', 'bin');
let COOKIE = path.join(__dirname, '..', 'resources', 'cookies.txt');
let OUTDIR = null;
let PROXY = null;
let GDL_CFG = null;   // gallery-dl 配置：stdout/stderr 强制 UTF-8（韩/日/emoji 否则被内部替换成 '???'）
function configure({ binDir, cookiePath, outDir, proxy }) {
  if (binDir) BIN = binDir;
  if (cookiePath) COOKIE = cookiePath;
  if (outDir) OUTDIR = outDir;
  if (proxy !== undefined) PROXY = proxy || null;   // 空串清除
  try {
    GDL_CFG = path.join(path.dirname(COOKIE), 'gdl-utf8.json');
    fs.writeFileSync(GDL_CFG, JSON.stringify({ output: {
      stdout: { encoding: 'utf-8', errors: 'replace' },
      stderr: { encoding: 'utf-8', errors: 'replace' },
    } }));
  } catch (e) { GDL_CFG = null; console.warn('[queue] gdl config write fail:', e.message); }
}
// gallery-dl 启动参数前缀（所有 spawn 共用）
function gdlBaseArgs() {
  return GDL_CFG ? ['--config', GDL_CFG] : [];
}

// 引擎错误分类：识别风控/限流信号（词边界防误判：避免匹配到文件大小「412MB」之类）
function isRateLimitError(text) {
  return /\b(412|429)\b|-352|rate.?limit|Too Many Requests|Waiting for \d+ (minutes|seconds)|Precondition Failed|请求过于频繁/i.test(text || '');
}

// 会审 T4：Windows 下引擎会再 spawn 子进程（yt-dlp→ffmpeg 合并）；只 kill 父进程会留孤儿
// 继续写同一文件。taskkill /T 连整棵进程树一起杀，失败回落 SIGKILL
function killTree(child) {
  if (!child) return;
  try { if (child.exitCode !== null) return; } catch (e) {}
  if (process.platform === 'win32' && child.pid) {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).unref();
      return;
    } catch (e) {}
  }
  try { child.kill('SIGKILL'); } catch (e) {}
}

class DownloadQueue {
  constructor(broadcast) {
    this.broadcast = broadcast;
    this.items = new Map();
    this.order = [];
    this.active = 0;
    this.max = 2;
    this._heldTimer = null;
  }

  add(url, meta = {}) {
    const u = String(url || '').trim();
    if (!u) return null;
    // 查重（会审 P0 修复）：同 URL 活跃任务直接返回已有项并打 duplicate 标记，UI 提示不重复入队
    for (const it of this.items.values()) {
      if (it.url === u && ['queued', 'downloading', 'held'].includes(it.status)) {
        return { ...it, duplicate: true };
      }
    }
    const id = 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const item = {
      id, url: u, engine: meta.engine || 'unknown',
      status: 'queued',               // queued|downloading|held|done|error|canceled
      progress: 0, title: meta.title || u, uploader: meta.uploader || null,
      filePath: null, fileCount: 0, error: null, addedAt: Date.now(),
      _range: meta._range || null,
      _subs: !!meta._subs, _audio: !!meta._audio, _transcribe: !!meta._transcribe,
      _subId: meta._subId || null,   // 订阅来源任务：改名后标题同步用
    };
    // 入队即检查熔断：该站冷却中直接挂起
    if (strategy.isBreakered(item.url)) {
      item.status = 'held';
      item.error = '站点风控冷却中';
    }
    this.items.set(id, item);
    this.order.push(id);
    this.tick();
    this.push();
    return item;
  }

  cancel(id) {
    const it = this.items.get(id);
    if (!it) return false;
    if (['queued', 'downloading', 'held'].includes(it.status)) {
      killTree(it._child);
      if (it._wasActive) { this.active = Math.max(0, this.active - 1); it._wasActive = false; }
      it.status = 'canceled';
      this.tick();
      this.push();
      return true;
    }
    return false;
  }

  // 重试：error/held/canceled/done → queued（重置进度统计，防跨次累加虚高）
  // 会审 B8：done 也允许重试——doneCard 本来就渲染了 ⟳ 按钮，点了却无响应；gallery-dl 重跑会自动跳过已有文件
  retry(id) {
    const it = this.items.get(id);
    if (!it || !['error', 'held', 'canceled', 'done'].includes(it.status)) return false;
    it.status = strategy.isBreakered(it.url) ? 'held' : 'queued';
    it.error = null;
    it.progress = 0;
    it.fileCount = 0;
    this.tick(); this.push();
    return true;
  }

  // 删除任务记录（只清列表记录，不动磁盘文件）。活跃任务先取消再删
  remove(id) {
    const it = this.items.get(id);
    if (!it) return false;
    if (!['done', 'error', 'canceled'].includes(it.status)) this.cancel(id);
    this.items.delete(id);
    this.order = this.order.filter(x => x !== id);
    this.push();
    return true;
  }

  // 批量清空终态任务（done/error/canceled）的记录
  clearFinished() {
    const FIN = ['done', 'error', 'canceled'];
    const ids = this.order.filter(id => FIN.includes(this.items.get(id).status));
    for (const id of ids) this.items.delete(id);
    this.order = this.order.filter(id => this.items.has(id));
    this.push();
    return ids.length;
  }

  // 订阅改名后同步历史任务标题（老任务在改名前入队，标题里还带着「订阅 N」占位名）
  renameSub(subId, name) {
    let n = 0;
    for (const it of this.items.values()) {
      if (it._subId !== subId) continue;
      const nt = it.title.replace(/^((?:\[订阅回溯\]|\[订阅\])\s+)[^·]+?(\s*·|$)/, `$1${name}$2`);
      if (nt !== it.title) { it.title = nt; n++; }
    }
    return n;
  }

  snapshot() {
    return this.order.map(id => {
      // 保留 _range（会审修复：先前被剥离导致范围任务崩溃恢复后全量重下）；_files 巨大且只供 onDone 钩子用，不入快照
      const { _child, _wasActive, _files, ...rest } = this.items.get(id);
      if (rest.status === 'held') rest.heldRemainMs = strategy.breakerRemainMs(rest.url);
      return rest;
    });
  }

  push() {
    this.pruneFinished();   // 会审 P2：终态任务上限淘汰，防长驻内存/tasks.json 无限膨胀
    this.broadcast(this.snapshot());
  }

  pruneFinished() {
    const FIN = ['done', 'error', 'canceled'];
    const finished = this.order.filter(id => FIN.includes(this.items.get(id).status));
    if (finished.length > 200) {
      for (const id of finished.slice(0, finished.length - 200)) this.items.delete(id);
      this.order = this.order.filter(id => this.items.has(id));
    }
  }

  tick() {
    // 熔断解除的 held 任务回队
    for (const id of this.order) {
      const it = this.items.get(id);
      if (it.status === 'held' && !strategy.isBreakered(it.url)) {
        it.status = 'queued';
        it.error = null;
      }
    }
    while (this.active < this.max) {
      const next = this.order.map(i => this.items.get(i))
        .find(it => it.status === 'queued' && !strategy.isBreakered(it.url));
      if (!next) break;
      this.run(next);
    }
    // 若有 held 任务，或存在被熔断卡住的 queued 任务（会审 DGO-007：否则取消 held 后同站 queued 永久无唤醒源），定时回查
    const hasHeld = this.order.some(i => this.items.get(i).status === 'held');
    const queuedOnBreaker = !hasHeld && this.order.some(i => {
      const it = this.items.get(i);
      return it.status === 'queued' && strategy.isBreakered(it.url);
    });
    if ((hasHeld || queuedOnBreaker) && !this._heldTimer) {
      this._heldTimer = setTimeout(() => { this._heldTimer = null; this.tick(); this.push(); }, 30 * 1000);
    }
  }

  run(it) {
    it.status = 'downloading';
    if (!Array.isArray(it._files)) it._files = [];   // 本次尝试产出的文件清单（跨重试累积；重试时引擎会跳过已存在文件）
    this.active++;
    it._wasActive = true;
    const done = (status, extra = {}) => {
      if (!it._wasActive) return;   // 幂等守卫（会审 P1）：spawn 的 error+close 双触发只算一次
      it.status = status;
      Object.assign(it, extra);
      if (status === 'done' && this.onDone) {
        try { this.onDone(it); } catch (e) { console.warn('[queue] onDone hook fail:', e.message); }   // 来源索引（媒体库溯源用）
      }
      this.active = Math.max(0, this.active - 1);
      it._wasActive = false;
      this.tick();
      this.push();
    };

    const args = this.buildArgs(it);
    if (!args) return done('error', { error: '不支持的引擎: ' + it.engine });

    fs.mkdirSync(OUTDIR, { recursive: true });
    // 编码：两引擎输出均为 UTF-8（yt-dlp 用 --encoding；gallery-dl 用 --config 强制 stdout/stderr 为 UTF-8）
    const ytdlpDec = 'utf-8';
    const decOut = new TextDecoder(ytdlpDec);
    const decErr = new TextDecoder(ytdlpDec);
    const child = spawn(args.exe, args.args, { windowsHide: true });
    it._child = child;

    child.stdout.on('data', d => this.parseOutput(it, decOut.decode(d, { stream: true })));
    child.stderr.on('data', d => this.parseOutput(it, decErr.decode(d, { stream: true })));
    child.on('error', e => {
      // 引擎文件缺失（首启在线引导还没下载完 / 杀软误删）→ 给出可行动的提示而非裸 ENOENT
      const msg = /ENOENT|spawn/i.test(String(e)) && !fs.existsSync(args.exe)
        ? '下载引擎尚未就绪（首次运行需联网自动下载，几十秒后重试即可；若反复出现请检查杀毒软件是否拦截）'
        : String(e);
      done('error', { error: msg });
    });
    child.on('close', code => {
      if (!it._wasActive || it.status === 'canceled') return;   // 幂等守卫（含 cancel 后的 close）
      if (code === 0) {
        strategy.reportSuccess(it.url);
        done('done', { progress: 100, filePath: it.filePath });
      } else {
        const rate = isRateLimitError(it.error);
        const st = strategy.reportFailure(it.url, rate);
        const breakerNow = strategy.isBreakered(it.url);
        const msg = (rate ? '[风控/限流] ' : '') + (it.error || ('引擎退出 code=' + code));
        done(breakerNow ? 'held' : 'error', {
          error: msg.slice(0, 300),
          level: st.level
        });
      }
    });
  }

  buildArgs(it) {
    const ytdlp = path.join(BIN, exe('yt-dlp'));
    const gdl = path.join(BIN, exe('gallery-dl'));
    if (it.engine === 'yt-dlp') {
      // 媒体库物理目录：{站点}/{UP主}/{标题} [id].ext（与 gallery-dl 的 bilibili/{作者}/ 结构对齐）
      const site = /bilibili\.com/i.test(it.url) ? 'bilibili'
        : /youtube\.com|youtu\.be/i.test(it.url) ? 'youtube' : 'other';
      const outTpl = path.join(OUTDIR, site, '%(uploader|Unknown)s', '%(title)s [%(id)s].%(ext)s');
      // ffmpeg 可能尚未就绪（首启在线引导下载中）→ 降级为单文件流，不合并、不抽轨，保住可用性
      const hasFfmpeg = fs.existsSync(path.join(BIN, exe('ffmpeg')));
    const args = [
        '-f', it._audio ? 'bestaudio/best' : (!hasFfmpeg ? 'b' : 'bv*[vcodec^=avc1]+ba[acodec^=mp4a]/bv*+ba/b'),
        '-S', it._audio ? 'abr' : 'res:1080',
        '--merge-output-format', 'mp4',
        ...(hasFfmpeg ? ['--ffmpeg-location', path.join(BIN, exe('ffmpeg'))] : []),
        '-o', outTpl,
        '--newline', '--no-playlist', '--windows-filenames',
        '--concurrent-fragments', '4',   // DASH 分段 4 路并行（B站/YouTube 视频皆分段下发），实测提速 2~4 倍
        '--encoding', 'utf-8',   // 管道默认 ANSI(GBK)，韩文/emoji 等字符直接丢——强制 UTF-8 保住完整文件名
        '--mtime',   // 用 HTTP Last-Modified 设文件时间＝发帖时间，媒体库才能按帖子发布时间排序
        '--print', 'after_move:filepath',
    ];
      // 仅音频模式（转写/听播客场景）：ffmpeg 抽轨转 mp3（无 ffmpeg 时降级下 bestaudio 原格式）
      if (it._audio && hasFfmpeg) args.push('-x', '--audio-format', 'mp3', '--audio-quality', '5');
      // 随视频下载字幕（转写替代/辅助）：优先中文，AI 自动字幕也收；拿不到不阻塞下载
      if (it._subs) args.push('--write-subs', '--write-auto-subs', '--sub-langs', 'zh.*,zh,en.*', '--convert-subs', 'srt');
      const st = strategy.forUrl(it.url);
      // 注意：yt-dlp 裸 --sleep 有歧义（ambiguous），必须用 --sleep-interval；gallery-dl 才用 --sleep
      if (st.sleep > 0) args.push('--sleep-interval', String(st.sleep), '--sleep-requests', String(Math.max(1, st.sleep)));
      if (PROXY) args.push('--proxy', PROXY);   // YouTube 等被墙站点走用户代理
      if (fs.existsSync(COOKIE)) args.push('--cookies', COOKIE);
      args.push('-P', OUTDIR, it.url);
      return { exe: ytdlp, args };
    }
    if (it.engine === 'gallery-dl') {
      const st = strategy.forUrl(it.url);
      const args = [...gdlBaseArgs(), '-d', OUTDIR, '--windows-filenames'];
      if (st.sleep > 0) args.push('--sleep', String(st.sleep));
      if (it._range) args.push('--range', it._range);
      if (PROXY) args.push('--proxy', PROXY);
      if (fs.existsSync(COOKIE)) args.push('--cookies', COOKIE);
      args.push(it.url);
      return { exe: gdl, args };
    }
    return null;
  }

  parseOutput(it, chunk) {
    for (const rawLine of chunk.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      if (it.engine === 'yt-dlp') {
        if (!line.startsWith('[') && /^[A-Za-z]:\\/.test(line)) { it.filePath = line; if (!it._files.includes(line)) it._files.push(line); continue; }
        const m = line.match(/\[download\]\s+([\d.]+)%/);
        if (m) it.progress = Math.max(it.progress, parseFloat(m[1]));
        if (line.startsWith('ERROR')) it.error = line;
      } else if (it.engine === 'gallery-dl') {
        // 实测输出格式："# D:\Downloads\...\1.jpg"（# 前缀+绝对路径）；旧版本是 "./相对路径"
        if (line.startsWith('# ') || line.startsWith('./')) {
          it.fileCount++;
          it.filePath = line.startsWith('# ') ? line.slice(2).trim() : path.join(OUTDIR, line.slice(2));
          if (!it._files.includes(it.filePath)) it._files.push(it.filePath);
          it.progress = Math.min(99, it.fileCount * 10);
        }
        if (/^ERROR/i.test(line)) it.error = line;
        // gallery-dl 的限速等待也是风控信号
        const wait = line.match(/Waiting for (\d+) minutes?/i);
        if (wait) it.error = '站点限流：等待 ' + wait[1] + ' 分钟';
      }
    }
    this.pushThrottled();
  }

  pushThrottled() {
    if (this._lastPush && Date.now() - this._lastPush < 300) { this._dirty = true; return; }
    this._lastPush = Date.now();
    this.push();
    if (this._dirty) { this._dirty = false; setTimeout(() => this.pushThrottled(), 350); }
  }
}

module.exports = { DownloadQueue, configure };
