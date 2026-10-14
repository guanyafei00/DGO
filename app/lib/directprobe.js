// 直连探测：隐藏窗口加载视频页，让页面自己过反爬，webRequest 截获播放器真实 CDN 流。
// 适用于抖音/快手等 yt-dlp/gallery-dl 均无法解析（JSVMP 签名/GraphQL+cookie）的国内短视频站。
// 设计约束：纯探测不执行页面脚本之外的任何签名逻辑——反爬对抗交给 Chromium 本体，永远比手写 a_bogus 移植活得久。
const MEDIA_URL_RE = /\.(mp4|m3u8|flv)(\?|$)|douyinvod\.com|bytecdn\.cn|zjcdn\.com\/aweme|kwaicdn\.com|gifshow\.com|yximgs\.com|appdirtybyte/i;
const IMG_RE = /\.(jpg|jpeg|png|webp|heic|gif|ico|svg|css|js|woff2?|ts|json)(\?|$)/i;

function sanitizeName(s, fallback = 'video') {
  const t = String(s || '').replace(/[\\/:*?"<>|\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  return (t || fallback).slice(0, 80);
}

// probe(pageUrl, opts) -> Promise<{ url, title, site } | { error }>
//   url     = 播放器正在拉取的媒体直链（每次运行现取，签名/时效新鲜）
//   title   = document.title（页面标题，一般含作者/描述）
//   site    = 'douyin' | 'kuaishou' | 'direct'
async function probe(pageUrl, { timeoutMs = 25000, site = 'direct', electron = null } = {}) {
  let BrowserWindow;
  try { BrowserWindow = (electron || require('electron')).BrowserWindow; }
  catch (e) { return { error: '探测模块仅在主进程可用（Electron 运行时）' }; }
  return new Promise(resolveP => {
    let settled = false, win = null, mediaUrl = null, title = null;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { if (win && !win.isDestroyed()) win.destroy(); } catch (e) {}
      resolveP(val);
    };
    const timer = setTimeout(() => {
      finish(mediaUrl ? { url: mediaUrl, title: title || null, site }
        : { error: '页面加载超时或未探测到视频流（站点可能弹验证/需登录，稍后重试）' });
    }, timeoutMs);
    try {
      win = new BrowserWindow({
        show: false, width: 420, height: 760,   // 手机竖屏比例：抖音/快手分享页都按 UA 出移动版
        webPreferences: { partition: 'directprobe-' + Date.now(), javascript: true, sandbox: true },
      });
      win.webContents.session.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1');
      // 截获媒体请求：只认媒体 CDN/扩展名，排除图片静态资源
      win.webContents.session.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, cb) => {
        if (!details.url || IMG_RE.test(details.url)) return cb({});
        if (MEDIA_URL_RE.test(details.url)) {
          if (!mediaUrl || /mp4/i.test(details.url)) mediaUrl = details.url;   // mp4 优先（比 m3u8 免合并）
        }
        cb({});
      });
      win.webContents.on('did-finish-load', async () => {
        setTimeout(async () => {
          try { const t = await win.webContents.executeJavaScript('document.title', true); if (t) title = t; } catch (e) {}
          if (mediaUrl) finish({ url: mediaUrl, title: title || null, site });
        }, 2500);   // 给播放器 2.5s 发起视频请求
      });
      win.webContents.on('did-fail-load', () => { if (!mediaUrl) finish({ error: '页面加载失败（网络不可达）' }); });
      win.loadURL(pageUrl).catch(() => {});
    } catch (e) {
      finish({ error: '探测窗口创建失败: ' + String(e && e.message || e).slice(0, 80) });
    }
  });
}

module.exports = { probe, sanitizeName };
