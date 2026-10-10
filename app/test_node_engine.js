// M0 验证：Node spawn 官方 yt-dlp.exe 下载 B 站视频（游客 cookie + worst 画质）
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const APP = __dirname;
const BIN = path.join(APP, 'resources', 'bin');
const COOKIE = path.join(APP, 'resources', 'cookies.txt');
const OUT = path.join(APP, 'downloads');
fs.mkdirSync(OUT, { recursive: true });

const URL = process.argv[2] || 'https://www.bilibili.com/video/BV1GJ411x7h7';
const args = [
  '-f', 'bv*[vcodec^=avc1]+ba[acodec^=mp4a]/bv*+ba/b',
  '-S', 'res:360',
  '--merge-output-format', 'mp4',
  '--ffmpeg-location', path.join(BIN, 'ffmpeg.exe'),
  '--no-playlist',
  '--newline',
  '--windows-filenames',
  '--cookies', COOKIE,
  '-P', OUT,
  URL
];

console.log('[spawn]', path.join(BIN, 'yt-dlp.exe'));
const child = spawn(path.join(BIN, 'yt-dlp.exe'), args, { windowsHide: true });
const t0 = Date.now();
let lastLine = '';

child.stdout.on('data', d => {
  for (const line of d.toString().split('\n')) if (line.trim()) { lastLine = line; console.log('  ', line.trim()); }
});
child.stderr.on('data', d => {
  for (const line of d.toString().split('\n')) if (line.trim()) console.log('  [err]', line.trim());
});
child.on('error', e => { console.error('[spawn error]', e.message); process.exit(2); });
child.on('close', code => {
  const sec = ((Date.now() - t0) / 1000).toFixed(1);
  const files = fs.readdirSync(OUT).filter(f => !f.endsWith('.part'));
  console.log(`\n[exit] code=${code} 耗时=${sec}s`);
  console.log('[产物]', files.map(f => `${f} (${(fs.statSync(path.join(OUT, f)).size / 1e6).toFixed(1)}MB)`).join(', ') || '无');
  if (code === 0 && files.length) { console.log('M0_NODE_TEST_PASS'); process.exit(0); }
  console.log('M0_NODE_TEST_FAIL  lastLine:', lastLine);
  process.exit(1);
});
