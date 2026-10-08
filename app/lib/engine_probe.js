// 引擎自检（独立模块，供 main 与 autotest 复用）
const { spawn } = require('child_process');
const path = require('path');

function runEngine(binDir) {
  const run = (file, args, timeoutMs = 15000) => new Promise(resolve => {
    let out = '', err = '';
    const started = Date.now();
    let child;
    try { child = spawn(file, args, { windowsHide: true }); }
    catch (e) { return resolve({ ok: false, error: String(e) }); }
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => err += d);
    child.on('error', e => { clearTimeout(timer); resolve({ ok: false, error: String(e) }); });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ ok: code === 0, out: (out || err).trim(), ms: Date.now() - started });
    });
  });

  return Promise.all([
    run(path.join(binDir, 'yt-dlp.exe'), ['--version']),
    run(path.join(binDir, 'gallery-dl.exe'), ['--version']),
    run(path.join(binDir, 'ffmpeg.exe'), ['-version'], 10000)
  ]).then(([y, g, f]) => ({
    ytDlp: { ok: y.ok, version: (y.out || y.error || '').split('\n')[0], ms: y.ms },
    galleryDl: { ok: g.ok, version: (g.out || g.error || '').split('\n')[0], ms: g.ms },
    ffmpeg: { ok: f.ok, version: (f.out || '').split('\n')[0] || f.error }
  }));
}

module.exports = { runEngine };
