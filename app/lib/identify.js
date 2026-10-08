// 链接识别：URL 模式匹配分流 + yt-dlp 探测兜底
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const enc = require('./enc');

let BIN = path.join(__dirname, '..', 'resources', 'bin');
let COOKIE_PATH = path.join(__dirname, '..', 'resources', 'cookies.txt');
let PROXY = null;
function setBinDir(dir) { BIN = dir; }
function setCookiePath(p) { COOKIE_PATH = p; }   // 会审 P1 修复：登录后识别探针也带上 cookie
function setProxy(p) { PROXY = p || null; }

// 已知图片/图文站 → gallery-dl（命中即信任，不做网络探测）
const GALLERY_PATTERNS = [
  /space\.bilibili\.com\/\d+/i,        // B站 UP 主页（动态图片流）
  /bilibili\.com\/opus\/\d+/i,         // B站图文动态
  /pixiv\.net/i,
  /twitter\.com\//i, /(?:^|\.)x\.com\//i,
  /instagram\.com/i,
  /weibo\.com/i, /weibo\.cn/i,
  /huashi6\.com/i, /artstation\.com/i,
  /danbooru\.donmai\.us/i, /gelbooru\.com/i, /yande\.re/i, /konachan\.com/i,
  /imgur\.com/i, /flickr\.com/i,
];

const VIDEO_HINTS = [
  /bilibili\.com\/video\//i,
  /youtube\.com|youtu\.be/i,
  /v\.qq\.com/i, /ixigua\.com/i, /douyin\.com/i, /kuaishou\.com/i,
  /twitch\.tv/i, /vimeo\.com/i, /dailymotion\.com/i,
];

function classify(url) {
  const u = url.trim();
  if (!/^https?:\/\//i.test(u)) return { engine: 'invalid', reason: '不是 http(s) 链接' };
  if (GALLERY_PATTERNS.some(re => re.test(u))) return { engine: 'gallery-dl' };
  if (VIDEO_HINTS.some(re => re.test(u))) return { engine: 'yt-dlp' };
  return { engine: 'unknown' }; // 交给 yt-dlp 探测（1000+ 站兜底）
}

// yt-dlp 探测：拿到标题/UP主/时长；flat-playlist 秒级识别合集
function probe(url, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const cookie = COOKIE_PATH;
    const args = ['--dump-single-json', '--flat-playlist', '--no-warnings', '--skip-download', '--encoding', 'utf-8'];
    if (fs.existsSync(cookie)) args.push('--cookies', cookie);
    if (PROXY) args.push('--proxy', PROXY);
    args.push(url.trim());
    let out = '';
    const dec = new TextDecoder('utf-8');   // yt-dlp 已强制 --encoding utf-8（与 queue.js/subs.js 统一）
    const child = spawn(path.join(BIN, 'yt-dlp.exe'), args, { windowsHide: true });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', d => { out += dec.decode(d, { stream: true }); });
    child.on('error', e => { clearTimeout(timer); resolve({ engine: 'yt-dlp', ok: false, reason: String(e) }); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0 || !out.trim()) return resolve({ engine: 'yt-dlp', ok: false, reason: '无法解析此链接' });
      try {
        const j = JSON.parse(out);
        resolve({
          engine: 'yt-dlp', ok: true,
          title: j.title || null,
          uploader: j.uploader || j.channel || null,
          duration: j.duration || null,
          isPlaylist: !!j._type || (j.entries && j.entries.length > 0),
          entryCount: j.entries ? j.entries.length : 1,
          extractor: j.extractor_key || null
        });
      } catch (e) {
        resolve({ engine: 'yt-dlp', ok: false, reason: '解析输出失败' });
      }
    });
  });
}

// 统一入口：识别 + （视频侧）元数据探测
async function identify(url) {
  const c = classify(url);
  if (c.engine === 'gallery-dl') return { engine: 'gallery-dl', ok: true, title: null, uploader: null };
  if (c.engine === 'invalid') return c;
  const p = await probe(url);
  return p;
}

module.exports = { identify, classify, probe, setBinDir, setCookiePath, setProxy };
