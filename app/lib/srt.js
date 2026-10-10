// SRT 字幕处理（阶段一）：解析 / 分块翻译 / 双语合成
// 设计：translator 由调用方注入（main.js 绑 ai.run）——本模块不依赖网络，单测可灌假翻译器
const fs = require('fs');

// 解析 SRT → [{ idx, time, text }]；time 是原始时间轴行（原样保留，绝不改时间轴）
// 数字行可能是「下一块序号」也可能是正文（如"第 42 条"）：待定 + 前瞻下一行是否时间轴再定
function parseSrt(text) {
  const blocks = [];
  let cur = null, pending = null; // pending: 已读到的纯数字行（尚未定性）
  const flushCur = () => { if (cur && cur.text.length) blocks.push(cur); cur = null; };
  const pushPending = () => { if (pending !== null && cur) { cur.text.push(String(pending)); pending = null; } };
  const lines = String(text).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimEnd();
    const t = line.trim();
    const isNum = /^\d+$/.test(t);
    if (!cur && isNum) { cur = { idx: parseInt(t, 10), time: '', text: [] }; continue; }
    if (cur && !cur.time && line.includes('-->')) { cur.time = t; continue; }
    if (cur) {
      if (t === '') {
        pushPending();
        flushCur();
        continue;
      }
      if (isNum && cur.time) {
        const next = (lines[i + 1] || '').trim();
        if (next.includes('-->')) {   // 序号 + 时间轴 = 新块开始（前块无文本也照常丢弃）
          pushPending();
          flushCur();
          cur = { idx: parseInt(t, 10), time: '', text: [] };
          continue;
        }
        pushPending();
        pending = parseInt(t, 10);    // 待定：先当可能的正文存着
        continue;
      }
      pushPending();
      cur.text.push(line);
    }
  }
  pushPending();
  flushCur();   // 无结尾空行也收
  return blocks;
}

function fmtBlock(b) {
  return b.idx + '\n' + b.time + '\n' + b.text.join('\n') + '\n';
}
function formatSrt(blocks) {
  return blocks.map(fmtBlock).join('\n');
}

// 分块大小：按字符预算（防止长行超模型上下文），单块最多 40 条且 ≤ 6000 字符
function chunkBlocks(blocks) {
  const chunks = [];
  let cur = [], curChars = 0;
  for (const b of blocks) {
    const c = b.text.join('\n').length;
    if (cur.length >= 40 || (curChars + c > 6000 && cur.length)) { chunks.push(cur); cur = []; curChars = 0; }
    cur.push(b); curChars += c;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

function buildPrompt(blocks) {
  return blocks.map((b, i) => (i + 1) + '|' + b.text.join(' ')).join('\n');
}

// 解析模型输出「N|译文」→ Map(n => 译文)；容忍编号乱序，忽略空行/解释行
function parseReplies(out, expectN) {
  const map = new Map();
  for (const raw of String(out).replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^(\d{1,4})\s*[|｜:：]\s*(.+)$/.exec(line);
    if (!m) continue;
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= expectN && !map.has(n)) map.set(n, m[2].trim());
  }
  return map;
}

// 翻译一个分块，失败/缺行自动重试一次；仍不齐则抛错（携带缺行号，方便定位）
async function translateChunk(blocks, translator, sysHint) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const out = await translator(buildPrompt(blocks), sysHint);
    const map = parseReplies(out, blocks.length);
    const missing = blocks.filter((_, i) => !map.has(i + 1)).map((_, i) => i + 1);
    if (missing.length === 0) return blocks.map((_, i) => map.get(i + 1));
    if (attempt === 1) sysHint = `注意：你上次漏译了第 ${missing.join('、')} 条。重新输出全部 ${blocks.length} 行，格式严格为「N|译文」。原文：\n`;
  }
  const out = await translator(buildPrompt(blocks), sysHint);
  const map = parseReplies(out, blocks.length);
  const missing = blocks.filter((_, i) => !map.has(i + 1)).map((_, i) => i + 1);
  if (missing.length) throw new Error('模型漏译 ' + missing.length + ' 条（第 ' + missing.slice(0, 5).join('、') + ' 行），可重试或换模型');
  return blocks.map((_, i) => map.get(i + 1));
}

// 主入口：读 srtPath → 分块翻译 → 写双语 srtPath.replace(/\.srt$/i, '.zh.srt')
// translator(prompt, sysHint) → Promise<string>；onProgress(done, total)
async function translateSrt(srtPath, { translator, onProgress } = {}) {
  if (!translator) throw new Error('缺少翻译器');
  const blocks = parseSrt(fs.readFileSync(srtPath, 'utf-8'));
  if (!blocks.length) throw new Error('SRT 里没有有效字幕（时间轴/文本缺失）');
  const chunks = chunkBlocks(blocks);
  // 双语块：原文行 + 译文行（原文上译文下，与 pyVideoTrans 一致）
  const translated = new Array(blocks.length);
  let done = 0, offset = 0;
  for (const chunk of chunks) {
    const texts = await translateChunk(chunk, translator);
    chunk.forEach((_, i) => { translated[offset + i] = texts[i]; });
    offset += chunk.length;
    done = offset;
    if (onProgress) onProgress(done, blocks.length);
  }
  const bi = blocks.map((b, i) => ({ idx: b.idx, time: b.time, text: [...b.text, translated[i]] }));
  const outFile = srtPath.replace(/\.srt$/i, '') + '.zh.srt';
  fs.writeFileSync(outFile, formatSrt(bi), 'utf-8');
  return { ok: true, outFile, blocks: blocks.length };
}

module.exports = { parseSrt, formatSrt, chunkBlocks, buildPrompt, parseReplies, translateSrt };
