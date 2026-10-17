// 链接识别：URL 模式匹配分流 + yt-dlp 探测兜底
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const enc = require('./enc');

let BIN = path.join(__dirname, '..', 'resources', 'bin');
let COOKIE_PATH = path.join(__dirname, '..', 'resources', 'cookies.txt');
let PROXY = null;
function setBinDir(dir) { BIN = dir; }
function setCookiePath(p) { COOKIE_PATH = p; }   // 登录后识别探针也带上 cookie
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

// 直连探测站：yt-dlp 已无法解析（抖音 a_bogus JSVMP 签名 / 快手 GraphQL+cookie），
// 走隐藏窗口让页面自己过反爬，webRequest 截获 CDN 直链（directprobe.js）
const DIRECT_PATTERNS = [
  /(?:^|\.)douyin\.com\//i,          // 抖音网页/分享页（含 v.douyin.com 短链）
  /(?:^|\.)kuaishou\.com\//i,        // 快手
  /chenzhongtech\.com/i,             // 快手老域名
];

const VIDEO_HINTS = [
  /bilibili\.com\/video\//i,
  /youtube\.com|youtu\.be/i,
  /v\.qq\.com/i, /ixigua\.com/i,
  /tiktok\.com/i,   // TikTok：yt-dlp 提取器可用，但需要代理网络（queue 侧会带 --proxy）
  /twitch\.tv/i, /vimeo\.com/i, /dailymotion\.com/i,
];

function classify(url) {
  const u = url.trim();
  if (!/^https?:\/\//i.test(u)) return { engine: 'invalid', reason: '不是 http(s) 链接' };
  // B站合集/系列页 → yt-dlp（BilibiliCollectionList/SeriesList 提取器，实测 119 项 flat 秒回）。
  // 必须在 space.bilibili.com 通用规则之前：gallery-dl 不认合集页，会整单失败
  if (/space\.bilibili\.com\/\d+\/lists\/\d+/i.test(u) ||
      /space\.bilibili\.com\/\d+\/channel\/(?:collectiondetail|seriesdetail)\?/i.test(u)) return { engine: 'yt-dlp' };
  // 微信视频号：无任何开放提取器（需微信客户端私有协议），诚实拒绝并给替代路径
  if (/channels\.weixin\.qq\.com/i.test(u))
    return { engine: 'invalid', reason: '微信视频号暂不支持：需微信客户端私有协议，建议在手机端保存视频后手动放入下载目录' };
  if (DIRECT_PATTERNS.some(re => re.test(u))) return { engine: 'direct' };
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
  // 直连站不做 yt-dlp 元数据探测（注定失败白等 30 秒）；标题由 directprobe 加载页面时现取
  if (c.engine === 'direct') return { engine: 'direct', ok: true, title: null, uploader: null };
  const p = await probe(url);
  return p;
}

module.exports = { identify, classify, probe, setBinDir, setCookiePath, setProxy };
