// AI 文稿后处理（BYOK）：任意 OpenAI 兼容接口——OpenAI/DeepSeek/硅基流动/Ollama/LM Studio 通吃
// key 只存本地 settings.json，不经过任何第三方
const TASKS = {
  summary: {
    sys: '你是视频文稿助理。把用户给的视频/音频文字稿总结成结构化内容，用简体中文 Markdown 输出：一级标题为主题，然后「核心要点」列表（每条一句话）、「关键人物/数字」列表（如有）、「一句话总结」。只输出结果，不要解释。',
    user: t => `文字稿：\n${t}`,
  },
  translate: {
    sys: '你是专业字幕翻译。把用户给的内容逐段翻译成简体中文，忠实原意、口语自然。如果有 SRT 时间戳行（00:00:xx --> ...）原样保留不译。只输出译文，不要解释。',
    user: t => t,
  },
  srtTranslate: {
    sys: '你是专业字幕翻译。输入是编号字幕行（每行格式「N|文本」）。把每条逐条翻译成简体中文，忠实原意、口语自然、符合字幕长度习惯。输出必须与输入行数相同、编号相同，每行严格为「N|译文」，禁止输出编号范围之外的任何内容（无解释、无空行、无代码块标记）。',
    user: t => t,
  },
};

let CFG = { url: '', key: '', model: '' };
function configure(c) { CFG = { ...CFG, ...c }; }
function ready() { return !!(CFG.url && CFG.key && CFG.model); }

async function run(taskId, text) {
  const task = TASKS[taskId];
  if (!task) throw new Error('未知任务类型');
  if (!ready()) throw new Error('请先在设置里填 AI 接口地址 / API Key / 模型名');
  const body = JSON.stringify({
    model: CFG.model,
    messages: [
      { role: 'system', content: task.sys },
      { role: 'user', content: task.user(String(text).slice(0, 24000)) },   // 防超长：截 24k 字符
    ],
    temperature: 0.4,
  });
  const res = await fetch(CFG.url.replace(/\/+$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + CFG.key },
    body,
  });
  if (!res.ok) throw new Error('AI 接口 ' + res.status + ': ' + (await res.text()).slice(0, 200));
  const j = await res.json();
  const out = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  if (!out) throw new Error('AI 返回为空');
  return out;
}

module.exports = { configure, ready, run, TASKS };
