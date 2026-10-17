// 管道输出编码探测（中文 Windows = GBK(936)；
// 用户开启「UTF-8 全球语言支持」beta(65001) 或非中文 locale 时输出编码不同。
// 启动时探测一次 chcp，此后全局复用。探测是异步的，完成前的首次解码回落默认 gbk。
const { spawn } = require('child_process');

let ENC = 'gbk';
let detected = false;

function detect() {
  if (detected) return ENC;
  detected = true;
  try {
    const c = spawn('cmd.exe', ['/c', 'chcp'], { windowsHide: true });
    let o = '';
    c.stdout.on('data', d => { o += d.toString(); });
    c.on('error', () => {});
    c.on('close', () => {
      const m = o.match(/(\d+)/);
      if (!m) return;
      const map = { '936': 'gbk', '65001': 'utf-8', '932': 'shift-jis', '949': 'euc-kr', '950': 'big5' };
      if (map[m[1]]) ENC = map[m[1]];
    });
  } catch (e) { /* 探测失败保持 gbk 默认 */ }
  return ENC;
}

module.exports = { get encoding() { return detect(); } };
