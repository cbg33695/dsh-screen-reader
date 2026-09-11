// see-screen — 让 Agent 看见屏幕的 Cordis 插件（preset 平面）。
//
// ═══════════════════════════════════════════════════════════════════════════
// 改动前必读：这个文件里每一条设计决定都对应一次实测，不是口味问题。
// ═══════════════════════════════════════════════════════════════════════════
//
// 【结构】抓屏逻辑不在这个文件里，在 `scripts/capture.ps1`。
//   拆开的原因有两个：它可以用 powershell.exe 直接跑、单独验证（实测确实靠
//   这一步抓到了一个 Add-Type 的重复 using 编译错误，而挂载校验查不出来）；
//   以及它可以用 argv 数组调用，从而完全绕开 shell 引号问题。
//
// 【为什么用视觉模型而不是 Windows OCR】
//   实测 OCR 会把 "DeepSeek" 读成 "eepSeek"、把中文拆成带空格的单字。
//   换视觉模型后，标题栏中文路径、菜单、标签全部逐字命中。
//
// 【为什么第一层必须是"主体"，以及为什么还不够】
//   实测：同一张 Blender 截图、同一个模型——
//     · 提示词要求"逐字转录全部界面文字"时：把被选中的球体认成了立方体，
//       并且完全漏掉了物体顶部的尖顶形状（对照 .blend 真值：Cube 未被选中）。
//     · 只要求"忽略文字、说明视口里的物体"时：房子形状、尖顶、被选中的球
//       全部答对。
//   所以顺序固定为 主体 → 状态 → 细节 → 文字，文字放最后，截断时最先牺牲它。
//   注意：仅改提示词**没有**修好全窗图上的错误 —— 三次独立运行都在同一处答错
//   （说立方体被选中，真值是球体被选中）。所以准确度的杠杆不在措辞上。
//
// 【关于"字太小所以读不出"：三个受控实验全部不成立】
//   有人观察到真实 GUI 里一小段路径的点号读丢了，归因为"屏幕上的字太小"。
//   用受控图（文字与字号完全相同，只改画布）实测：
//     980x240   13/17/20/29px   全对
//     653x160   8.7/11.3/13.3/19.3px   全对（含 8.7px）
//     1920x1080 13/17/20/29px   全对
//   所以既不是绝对像素高度，也不是文字占图比例。剩下的解释是**渲染方式与对比度**
//   （真实 GUI 是浅灰字深灰底 + 浏览器次像素渲染，一旦被重采样，1px 宽的点号最先崩），
//   但这一点尚未做忠实对照验证 —— 不要把它当结论用。
//   唯一已验证的操作准则：**把目标区域裁出来**能显著改善，因为去掉了竞争内容。
//
// 【DPI：一个真实的、量化的浪费，已修】
//   本机屏幕是 1920x1080 @150%，而 powershell.exe 默认是 DPI-unaware 的，
//   Windows 会把桌面虚拟化成 1280x720，CopyFromScreen 于是返回一张缩小图 ——
//   在图像到达模型之前就丢掉了 56% 的像素。capture.ps1 现在先设置
//   PER_MONITOR_AWARE_V2，全屏恢复到 1920x1080。
//   （未验证：全屏下模型是否对输入做归一化；若做，则全屏准确度不变而上传变大。
//     裁切时这 1.5 倍真实像素才确定有用。）
//
// 【为什么必须处理 max-tokens】
//   实测这个模型会先产出大量推理 token 再产出正文，推理量随图像复杂度暴涨：
//     简单合成图   → 推理 788 tokens，正文正常
//     Blender 全窗 → 预算 1200 时推理吃掉全部 1200，正文 0 字符
//     Blender 视口 → 预算 6000 时推理吃掉全部 6000，正文 0 字符
//   而 finish 原因 max-tokens 不是 error。若不额外判断，就会把"空的失败"
//   当成"成功的空结果"返回 —— 静默失败，最难发现。所以这里：
//     a. 正文为空且不是正常结束 → 自动把预算翻倍重试一次；
//     b. 仍为空但有推理内容 → 返回推理片段并明确标注"正文被截断"；
//     c. 全空 → 抛错，绝不返回空的成功。
//
// 【省钱靠三个机制，不是靠少截图】
//   a. 变化侦测：抓帧后本地缩成 40x24 灰度指纹逐点比对，变化率低于
//      DIFF_THRESHOLD 直接丢弃 —— 屏幕没动就是 0 token。
//   b. 限流：两次视觉调用至少间隔 MIN_VISION_GAP_MS。
//   c. 滚动窗口：记忆只在内存里保留最近 WINDOW_MS，超时或超条数即丢弃。
//
// 【磁盘与隐私】
//   * 插件自己的截图：固定路径原地覆盖，磁盘上永远只有一份，插件停止时删除。
//   * **附件库是另一件事**：每次视觉调用都会调 attachments.saveImage，往
//     ${DSH_HOME}/attachments 新增一个内容寻址文件，且不会自己清理。实测一台
//     机器上已经积累到 24 个文件 / 2.0 MB。上面那句"只有一份"不覆盖它。
//   * 录制默认关闭，必须显式 screen_watch({on:true}) 才开始。
//
// 【实测已知的能力边界（不要期待它做不到的事）】
//   · 它是描述器不是量具：实测把 30px 的色带读成 40-45px，误差约 40%。
//   · 低对比度差异是危险区：两个相近灰色、1px 错位、微弱色差正是它会漏、
//     或更糟——自信地编一个的地方。
//   · 只有一帧，没有时间与因果。
//   · 准确度上限取决于提示词里的纪律，不是模型自带。
//
// 【平台】依赖 Windows 的 System.Drawing / PrintWindow 与 powershell.exe。
//
// ── 为什么这个文件只 import 一个 node: 内置模块 ──────────────────────────────
//
// 加载器的规则是：相对 specifier 按 preset 目录解析（可行），裸包名按 harness
// 安装位置解析（本地 preset 够不到 @deepseek-ai/dsh-tools）。所以这里刻意不依赖
// 任何包：工具定义不用 `defineTool(...)`，而是直接构造它产出的那个运行期结构；
// schema 用运行期 JSON Schema 原样书写，因此必须显式写 `required` 数组。
// `node:url` 是内置模块，不走 node_modules 查找，所以可用。

import { fileURLToPath } from 'node:url'

const name = 'see-screen'

// `tools` 是硬依赖：插件注册工具，Guard 不允许未声明就访问 ctx.tools。
// `timer` 提供 ctx.interval 混入，持续录制靠它。
// 其余服务（llm / subprocess / attachments / fs / sandboxPolicy / shell）都用
// ctx.get 可选读取并在缺失时如实报错。

const CAPTURE_SCRIPT = fileURLToPath(new URL('../scripts/capture.ps1', import.meta.url))

// ─── 可调参数 ──────────────────────────────────────────────────────────────

const SIG_W = 40 // 变化侦测指纹宽度
const SIG_H = 24 // 变化侦测指纹高度
const SIG_TOLERANCE = 14 // 单点灰度差超过它才算"这一格变了"（0-255）
const DIFF_THRESHOLD = 0.04 // 变化格占比低于它视为"画面没变"
const WINDOW_MS = 10 * 60 * 1000 // 短期记忆保留时长
const MAX_ENTRIES = 60 // 短期记忆条数上限
const ENTRY_CHARS = 3000 // 单条记忆最多存这么多字
const DEFAULT_INTERVAL_MS = 4000 // 默认抓帧间隔
const MIN_INTERVAL_MS = 2000 // 抓帧间隔下限
const MIN_VISION_GAP_MS = 12000 // 两次视觉调用最小间隔（花钱的闸门）
const VISION_TOKENS = 6000 // 单次视觉调用输出预算
const VISION_TOKENS_RETRY = 14000 // 正文为空时的重试预算

// 窗口抓取时，非黑像素比例低于它视为"没抓到内容"（PrintWindow 对某些 GPU
// 窗口会返回空白）。低于阈值就拒绝送模型，避免为一张黑图花钱。
// 只对窗口模式生效：整屏确实可能是纯黑的。
const MIN_NONBLACK = 2

// LOCATION 的解析与兜底。提示词要求模型单独给一行
//   LOCATION: x=<左>-<右>, y=<上>-<下>
// 但实测模型经常无视格式写散文（"上方约 1/5，左侧约 1/4"），所以这里必须解析、
// 必须给出可用的兜底，不能让调用方去猜散文。
const LOCATION_RE = /LOCATION\s*:\s*x\s*=\s*(\d{1,3})\s*(?:%|)\s*[-~至]\s*(\d{1,3})\s*(?:%|)\s*[,，]\s*y\s*=\s*(\d{1,3})\s*(?:%|)\s*[-~至]\s*(\d{1,3})/i
const LOCATION_NONE_RE = /LOCATION\s*:\s*none/i
const FALLBACK_REGION = '0.2,0.2,0.6,0.6' // 中心 60%，LOCATION 缺失时的兜底
const ZOOM_MARGIN = 0.06 // 解析出主体位置后向外扩一点，避免切掉边缘

const VISION_PROVIDER_HINT = 'deepseek-official'
const VISION_MODEL_HINT = 'deepseek-v4-flash-vision-exp'

const VISION_SYSTEM = [
  '你是屏幕信息转录与场景理解引擎。你的任务是准确读出屏幕上的信息，绝对不要猜测或补全。',
  '铁律：',
  '1. 先看整体再看细节。在转录任何界面文字之前，必须先确定画面主体。',
  '   界面文字是次要信息，不要为了抄文字而忽略画面内容。',
  '2. 逐字转录。代码、路径、命令行、ID、数字、报错信息必须原样照抄，不修正、不翻译、不顺滑化。',
  '3. 看不清的地方写 [?]，不要编造。宁可留空也不猜。',
  '4. 不确定就说不确定。只存在于你推测里的东西不要写成看到的东西。',
  '5. 不要做建议、不要评价、不要客套。',
  '6. 直接给出结果，不要展示思考过程。',
  '7. 格式要求必须逐字遵守，尤其是有固定写法的单行字段。',
].join('\n')

const VISION_PROMPT = [
  '请严格按下面的顺序输出四个小标题，不要添加其它内容。',
  '',
  '【主体】这是最重要的一项，必须最先回答。',
  '先用一句话直接说明：当前画面里的主体是什么？',
  '判断规则：',
  '- 只有一个明显主体时，直接说出它是什么。',
  '- 有多个并列主体时，全部列出，不要硬凑成一个。',
  '- 没有明确主体时（例如空桌面、纯色画面、多个窗口平分画面、纯装饰背景），',
  '  必须直接写"没有单一主体"，然后说明你实际看到的是什么。',
  '然后补充 2-4 句：主体的形态与构成，以及当前正在发生什么。',
  '最后必须单独起一行给出主体的位置。这一行不可省略，也不允许写成散文，',
  '只能照抄下面两种写法之一（百分比整数）：',
  'LOCATION: x=<左>-<右>, y=<上>-<下>',
  'LOCATION: none',
  '（有单一主体时用第一种；没有单一主体时用第二种。）',
  '',
  '【状态】有无弹窗、报错、加载中、按钮置灰、选中或高亮等状态。',
  '没有任何异常状态时写"无异常状态"。',
  '',
  '【细节】画面中关键元素的位置（上/下/左/右/中）、颜色、相对大小。',
  '若画面中存在被编辑过的非标准形状、或被选中/高亮的物体，必须特别指出',
  '它的具体形状以及选中状态。',
  '',
  '【文字】逐字转录画面中确实存在的文字，保留原有换行与缩进。',
  '看不清的地方写 [ ? ]。若画面中没有文字，写"画面中没有文字"。',
].join('\n')

function errText(error) {
  if (error === undefined || error === null) return 'unknown error'
  if (typeof error.message === 'string' && error.message.length > 0) return error.message
  return String(error)
}

function pick(text, prefix) {
  const lines = String(text || '').split(/\r?\n/)
  for (const line of lines) {
    if (line.startsWith(prefix)) return line.slice(prefix.length).trim()
  }
  return ''
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

// 把 LOCATION 那一行变成可以直接喂给 region 的归一化矩形。
// 返回 kind: 'box' | 'none' | 'missing'。missing 时给中心兜底，绝不留空。
function parseLocation(answer) {
  const text = String(answer || '')
  if (LOCATION_NONE_RE.test(text)) return { kind: 'none', region: '0,0,1,1', note: '模型报告没有单一主体，建议直接看整幅图' }
  const hit = LOCATION_RE.exec(text)
  if (hit === null) {
    return { kind: 'missing', region: FALLBACK_REGION, note: '模型没有按要求给出 LOCATION，已兜底为中心 60% 区域' }
  }
  const x1 = clamp01(Number(hit[1]) / 100 - ZOOM_MARGIN)
  const y1 = clamp01(Number(hit[3]) / 100 - ZOOM_MARGIN)
  const x2 = clamp01(Number(hit[2]) / 100 + ZOOM_MARGIN)
  const y2 = clamp01(Number(hit[4]) / 100 + ZOOM_MARGIN)
  const w = Math.max(0.05, x2 - x1)
  const h = Math.max(0.05, y2 - y1)
  const region = [clamp01(x1).toFixed(3), clamp01(y1).toFixed(3), w.toFixed(3), h.toFixed(3)].join(',')
  return { kind: 'box', region, note: '按模型给出的主体位置向内裁切（已外扩 ' + ZOOM_MARGIN + '）' }
}

// 指纹比较：先把 base64 解回真实字节再比，否则比较的是 base64 字符的 ASCII 码
// —— base64 字母表里 'A'(65) 与 'a'(97) 是相邻项但 ASCII 差 32，比较根本不
// 线性，SIG_TOLERANCE 的"灰度差 /255"语义会完全失真。
function decodeSig(base64) {
  try {
    return atob(String(base64 || ''))
  } catch {
    return ''
  }
}

function sigDelta(prev, cur) {
  if (prev === '' || cur === '') return 1
  const n = Math.min(prev.length, cur.length)
  if (n === 0) return 1
  let diff = 0
  for (let i = 0; i < n; i += 1) {
    if (Math.abs(cur.charCodeAt(i) - prev.charCodeAt(i)) > SIG_TOLERANCE) diff += 1
  }
  return diff / n + Math.abs(cur.length - prev.length) / n
}

const textBlock = (text) => [{ type: 'text', text }]

// ─── 插件本体 ──────────────────────────────────────────────────────────────

export function install(ctx) {
  const state = {
    prevSig: '',
    buffer: [],
    lastVisionAt: 0,
    timer: null,
    running: false,
    ticking: false,
    ticks: 0,
    changed: 0,
    skipped: 0,
    busySkips: 0,
    lastError: '',
    lastPath: '',
    window: '',
    region: '',
    vision: { provider: '', model: '', resolved: false, error: '', attempts: 0 },
  }

  function evict() {
    const floor = Date.now() - WINDOW_MS
    while (state.buffer.length > 0 && state.buffer[0].atMs < floor) state.buffer.shift()
    while (state.buffer.length > MAX_ENTRIES) state.buffer.shift()
  }

  // 用 argv 数组调用 PowerShell：完全绕开 shell 引号与转义，中文窗口标题、
  // 带空格的路径都不需要特殊处理。
  // subprocess 优先，shell 回退 —— 在这台机器上 shell 会被沙箱以
  // "no sandbox backend is usable" 拒绝，所以回退分支是必需的，不是装饰。
  async function runCaptureCli(args, timeoutMs) {
    const notes = []
    const subprocess = ctx.get('subprocess')
    const policy = ctx.get('sandboxPolicy')
    const cwd = policy !== undefined && policy !== null && typeof policy.workspaceRoot === 'string' ? policy.workspaceRoot : ''

    if (subprocess !== undefined && subprocess !== null && cwd !== '') {
      try {
        const exe = await subprocess.resolveExecutable('powershell.exe')
        const handle = subprocess.spawn({
          argv: [exe, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', CAPTURE_SCRIPT].concat(args),
          cwd,
          stdio: { stdin: 'ignore', stdout: { maxBytes: 1048576 }, stderr: { maxBytes: 65536 } },
          graceMs: 8000,
        })
        await handle.done
        const reader = handle.collected !== undefined ? handle.collected.stdout : undefined
        const text = reader !== undefined ? String(reader.readFrom(0).text || '') : ''
        if (text.includes('ERR=') || text.includes('PATH=') || text.includes('CLEANED')) {
          return { ok: true, text, notes }
        }
        const errReader = handle.collected !== undefined ? handle.collected.stderr : undefined
        notes.push('subprocess produced no payload; stderr=' + (errReader !== undefined ? String(errReader.readFrom(0).text || '').slice(0, 300) : ''))
      } catch (error) {
        notes.push('subprocess failed: ' + errText(error).slice(0, 200))
      }
    } else {
      notes.push(subprocess === undefined || subprocess === null ? 'subprocess service unavailable' : 'sandboxPolicy.workspaceRoot unavailable')
    }

    const shell = ctx.get('shell')
    if (shell !== undefined && shell !== null) {
      try {
        const quote = (value) => "'" + String(value).replace(/'/g, "''") + "'"
        const line = ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', quote(CAPTURE_SCRIPT)]
          .concat(args.map(quote))
          .join(' ')
        const spec = shell.resolve({ command: line, timeoutMs, stdoutMaxBytes: 1048576 })
        const run = await shell.run(spec)
        const stdout = run !== undefined && run.stdout !== undefined ? String(run.stdout.text || '') : ''
        if (stdout.includes('ERR=') || stdout.includes('PATH=') || stdout.includes('CLEANED')) {
          return { ok: true, text: stdout, notes }
        }
        notes.push('shell produced no payload (exit=' + String(run !== undefined ? run.exitCode : '?') + ')')
      } catch (error) {
        notes.push('shell failed: ' + errText(error).slice(0, 200))
      }
    }
    return { ok: false, text: '', notes }
  }

  async function capture(windowQuery, region) {
    const mode = windowQuery ? 'window' : 'screen'
    const args = ['-Mode', mode, '-SigW', String(SIG_W), '-SigH', String(SIG_H)]
    if (windowQuery) args.push('-Query', windowQuery)
    if (region) args.push('-Region', region)

    const run = await runCaptureCli(args, 40000)
    const empty = { ok: false, error: '', path: '', sig: '', width: 0, height: 0, target: '', nonBlack: '', mode }
    if (!run.ok) {
      empty.error = run.notes.join(' | ')
      return empty
    }
    const failure = pick(run.text, 'ERR=')
    if (failure !== '') {
      empty.error = failure
      return empty
    }
    const sig = pick(run.text, 'SIG=')
    const path = pick(run.text, 'PATH=')
    const size = pick(run.text, 'SIZE=').split('x')
    const nonBlack = pick(run.text, 'NONBLACK=')
    const result = {
      ok: sig !== '' && path !== '',
      error: sig !== '' && path !== '' ? '' : 'capture returned no signature or path',
      path,
      sig,
      width: Number(size[0]) || 0,
      height: Number(size[1]) || 0,
      target: pick(run.text, 'TARGET='),
      nonBlack,
      mode,
    }
    // 窗口抓取拿到近乎全黑 = PrintWindow 没能渲染这个窗口。此时送模型纯属浪费，
    // 而且会得到一段凭空描述黑屏的文字。
    const ratio = Number(nonBlack)
    if (mode === 'window' && Number.isFinite(ratio) && ratio < MIN_NONBLACK) {
      result.ok = false
      result.error = 'window capture appears blank (NONBLACK=' + nonBlack + '% < ' + MIN_NONBLACK + '%) — PrintWindow could not render this window; capture the whole screen instead'
    }
    return result
  }

  // 视觉路由发现。失败**不**缓存：llm 服务在首次调用时可能尚未就绪，把它记成
  // "永久不可用"会让插件一直残废到重载。
  async function resolveVision() {
    if (state.vision.resolved) return state.vision
    state.vision.attempts += 1
    const llm = ctx.get('llm')
    if (llm === undefined || llm === null) {
      state.vision.error = 'llm service unavailable'
      return state.vision
    }
    let providers = []
    try {
      providers = await llm.listProviders()
    } catch (error) {
      state.vision.error = 'listProviders failed: ' + errText(error)
      return state.vision
    }
    const found = []
    for (const provider of providers) {
      const pid = provider !== undefined && provider !== null ? String(provider.id || '') : ''
      if (pid === '') continue
      let models = []
      try {
        models = await llm.listModels(pid)
      } catch {
        continue
      }
      for (const model of models) {
        const mid = model !== undefined && model !== null ? String(model.id || '') : ''
        if (mid === '') continue
        try {
          const info = await llm.resolveModelInfo(pid, mid)
          const raw = info !== undefined && info !== null && Array.isArray(info.inputModalities) ? info.inputModalities : []
          if (raw.map(String).includes('image')) found.push({ provider: pid, model: mid })
        } catch {
          continue
        }
      }
    }
    const preferred = found.find((r) => r.provider === VISION_PROVIDER_HINT && r.model === VISION_MODEL_HINT)
    const chosen = preferred !== undefined ? preferred : found[0]
    if (chosen === undefined) {
      state.vision.error = 'no image-capable model route found'
      return state.vision
    }
    state.vision.provider = chosen.provider
    state.vision.model = chosen.model
    state.vision.error = ''
    state.vision.resolved = true
    return state.vision
  }

  async function readImageBytes(path) {
    const notes = []
    const fs = ctx.get('fs')
    if (fs !== undefined && fs !== null && path !== '') {
      try {
        const target = await fs.resolve(path)
        const bytes = await fs.readBytes(target, undefined, 33554432)
        if (bytes !== undefined && bytes !== null && bytes.length > 0) return { ok: true, bytes, notes }
        notes.push('fs.readBytes returned empty')
      } catch (error) {
        notes.push('fs failed: ' + errText(error).slice(0, 160))
      }
    } else {
      notes.push('fs service unavailable')
    }
    const run = await runCaptureCli(['-Mode', 'dump'], 30000)
    if (!run.ok) {
      notes.push('base64 dump unavailable')
      return { ok: false, bytes: null, notes }
    }
    const b64 = pick(run.text, 'B64=')
    if (b64 === '') {
      notes.push('base64 dump empty')
      return { ok: false, bytes: null, notes }
    }
    try {
      const bin = atob(b64)
      const arr = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i += 1) arr[i] = bin.charCodeAt(i)
      notes.push('used base64 fallback')
      return { ok: true, bytes: arr, notes }
    } catch (error) {
      notes.push('base64 fallback failed: ' + errText(error).slice(0, 160))
      return { ok: false, bytes: null, notes }
    }
  }

  async function callVision(llm, route, ref, prompt, budget) {
    const stream = llm.stream({
      provider: route.provider,
      model: route.model,
      system: VISION_SYSTEM,
      maxTokens: budget,
      messages: [
        {
          id: 'see-screen-frame',
          role: 'user',
          source: { kind: 'plugin', plugin: name },
          content: [
            { type: 'image', attachment: ref },
            { type: 'text', text: prompt },
          ],
        },
      ],
    })
    let text = ''
    let reasoning = ''
    let finish = '(none)'
    for await (const chunk of stream) {
      if (chunk === undefined || chunk === null) continue
      const kind = String(chunk.type || '')
      if (kind === 'text-delta') text += String(chunk.text || '')
      else if (kind === 'reasoning-delta') reasoning += String(chunk.text || '')
      else if (kind === 'finish' && chunk.reason !== undefined && chunk.reason !== null) {
        const reason = chunk.reason
        finish = String(reason.kind || '?')
        if (reason.failure !== undefined && reason.failure !== null) {
          throw new Error(String(reason.failure.message || reason.failure.code || 'model error'))
        }
      }
    }
    return { text: text.trim(), reasoning, finish }
  }

  // 把图交给视觉模型并取出正文。空正文绝不当作成功。
  async function transcribe(bytes, focus) {
    const route = await resolveVision()
    if (route.model === '') throw new Error('no vision route: ' + route.error)
    const attachments = ctx.get('attachments')
    const llm = ctx.get('llm')
    if (attachments === undefined || attachments === null) throw new Error('attachments service unavailable')
    if (llm === undefined || llm === null) throw new Error('llm service unavailable')

    // 注意：这一句每次调用都会往 ${DSH_HOME}/attachments 新增一个文件，
    // 且不会自动清理。见文件头部"磁盘与隐私"。
    const ref = await attachments.saveImage({ data: bytes, mediaType: 'image/png', name: 'screen.png' })
    const prompt = focus ? VISION_PROMPT + '\n\n特别注意（调用方关注点）：' + focus : VISION_PROMPT

    const first = await callVision(llm, route, ref, prompt, VISION_TOKENS)
    if (first.text !== '') {
      return { text: first.text, truncated: first.finish === 'max-tokens', finish: first.finish, retried: false }
    }

    const retryPrompt = prompt + '\n\n重要：请直接输出四个小标题的结论，不要展开任何思考过程。'
    let second = null
    try {
      second = await callVision(llm, route, ref, retryPrompt, VISION_TOKENS_RETRY)
    } catch {
      second = null
    }
    if (second !== null && second.text !== '') {
      return { text: second.text, truncated: second.finish === 'max-tokens', finish: second.finish, retried: true }
    }

    const reasoning = second !== null && second.reasoning.length > first.reasoning.length ? second.reasoning : first.reasoning
    if (reasoning !== '') {
      return {
        text: '[正文被截断：模型只产出了推理过程，未能生成正式回答。以下是推理片段，仅供参考，未经整理]\n' + reasoning.slice(0, 6000),
        truncated: true,
        finish: (second !== null ? second.finish : first.finish) + ' (reasoning-only)',
        retried: second !== null,
      }
    }
    throw new Error('vision produced no output (finish=' + first.finish + ', retried=' + (second !== null) + ')')
  }

  async function observe(force, focus, windowQuery, region) {
    state.ticks += 1
    const result = {
      changed: false, captured: false, transcribed: false, summary: '', error: '', reason: '',
      truncated: false, target: '', size: '', nonBlack: '', blank: false,
      locationKind: '', suggestedRegion: '', locationNote: '',
    }
    const frame = await capture(windowQuery, region)
    if (!frame.ok) {
      result.error = 'capture failed: ' + frame.error
      result.blank = frame.mode === 'window' && frame.error.includes('appears blank')
      state.lastError = result.error
      return result
    }
    result.captured = true
    result.target = frame.target
    result.size = frame.width + 'x' + frame.height
    result.nonBlack = frame.nonBlack
    state.lastPath = frame.path

    const currentSig = decodeSig(frame.sig)
    const delta = sigDelta(state.prevSig, currentSig)
    state.prevSig = currentSig

    if (!force && delta <= DIFF_THRESHOLD) {
      result.reason = 'unchanged (delta=' + delta.toFixed(4) + ')'
      state.skipped += 1
      return result
    }
    result.changed = true

    const gap = Date.now() - state.lastVisionAt
    if (!force && gap < MIN_VISION_GAP_MS) {
      result.reason = 'changed but rate-limited (gap=' + gap + 'ms, delta=' + delta.toFixed(4) + ')'
      state.skipped += 1
      return result
    }

    const read = await readImageBytes(frame.path)
    if (!read.ok) {
      result.error = read.notes.join(' | ')
      state.lastError = result.error
      return result
    }
    state.lastVisionAt = Date.now()

    try {
      const out = await transcribe(read.bytes, focus)
      result.transcribed = true
      result.summary = out.text
      result.truncated = out.truncated
      const location = parseLocation(out.text)
      result.locationKind = location.kind
      result.suggestedRegion = location.region
      result.locationNote = location.note
      state.lastError = out.truncated ? 'last answer was truncated (finish=' + out.finish + ')' : ''
      const atMs = Date.now()
      state.buffer.push({
        atMs,
        at: new Date(atMs).toISOString(),
        target: frame.target,
        size: frame.width + 'x' + frame.height,
        delta: delta.toFixed(4),
        truncated: out.truncated,
        text: out.text.slice(0, ENTRY_CHARS),
      })
      evict()
      state.changed += 1
    } catch (error) {
      result.error = 'vision failed: ' + errText(error)
      state.lastError = result.error
    }
    return result
  }

  // 互斥不只是省 token：并发抓帧会同时写同一个 dsh-screen.png，第二个覆盖时
  // 第一个正在读，会读到另一帧的图甚至半张图。
  async function tick(force, focus, windowOverride, regionOverride) {
    if (state.ticking) {
      state.busySkips += 1
      return {
        changed: false, captured: false, transcribed: false, summary: '', reason: 'busy: a previous observation is still running',
        error: '', truncated: false, target: '', size: '', nonBlack: '', blank: false,
        locationKind: '', suggestedRegion: '', locationNote: '',
      }
    }
    state.ticking = true
    try {
      const useWindow = typeof windowOverride === 'string' && windowOverride !== '' ? windowOverride : state.window
      const useRegion = typeof regionOverride === 'string' && regionOverride !== '' ? regionOverride : state.region
      return await observe(force === true, focus, useWindow, useRegion)
    } catch (error) {
      state.lastError = errText(error)
      return {
        changed: false, captured: false, transcribed: false, summary: '', error: state.lastError, reason: '',
        truncated: false, target: '', size: '', nonBlack: '', blank: false,
        locationKind: '', suggestedRegion: '', locationNote: '',
      }
    } finally {
      state.ticking = false
    }
  }

  function own(tool) {
    ctx.effect(() => ctx.tools.register(tool))
  }

  // ── 工具 1：持续录制开关（默认关闭）────────────────────────────────────

  own({
    name: 'screen_watch',
    description:
      'Start or stop continuous change-driven screen recording. While running, every meaningful change of the watched area is transcribed by a vision model into a rolling short-term memory that screen_memory reads. At most one screenshot file exists on disk (overwritten in place). Recording is OFF by default and must be started explicitly.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['on'],
      properties: {
        on: { type: 'boolean', description: 'true starts recording, false stops it.' },
        intervalMs: { type: 'number', description: 'Capture interval in ms (default 4000, minimum 2000).' },
        window: { type: 'string', description: 'Watch only this window: a process name or a window-title substring, case-insensitive. Omit to watch the whole desktop.' },
        region: { type: 'string', description: 'Extra crop as normalized x,y,w,h (0..1) against the captured area, e.g. "0.5,0.2,0.5,0.8". Omit to watch the whole area.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['running', 'intervalMs', 'watching', 'vision', 'entries', 'note'],
        properties: {
          running: { type: 'boolean' },
          intervalMs: { type: 'number' },
          watching: { type: 'string' },
          vision: { type: 'string' },
          entries: { type: 'number' },
          note: { type: 'string' },
        },
      },
      render(_args, value) {
        return textBlock(
          (value.running ? '已开始' : '已停止') +
            '持续读屏。间隔 ' + value.intervalMs + 'ms，监视范围 ' + value.watching +
            '，视觉模型 ' + value.vision + '，当前记忆条数 ' + value.entries + '。' + value.note,
        )
      },
    },
    async execute(args) {
      const on = args?.on === true
      const raw = typeof args?.intervalMs === 'number' ? args.intervalMs : DEFAULT_INTERVAL_MS
      const intervalMs = Math.max(MIN_INTERVAL_MS, Math.min(raw, 60000))
      if (state.timer !== null) {
        state.timer()
        state.timer = null
        state.running = false
      }
      state.window = typeof args?.window === 'string' ? args.window.trim() : ''
      state.region = typeof args?.region === 'string' ? args.region.trim() : ''
      let note = ''
      if (on) {
        const route = await resolveVision()
        if (route.model === '') note = ' 警告：还没找到支持图像的路由（会每秒重试），目前只会抓帧不会转录。' + route.error
        state.timer = ctx.interval(() => tick(false, ''), intervalMs)
        state.running = true
        state.prevSig = ''
      } else {
        note = ' 最后一张截图将在插件停止时删除。'
      }
      return {
        running: state.running,
        intervalMs,
        watching: state.window
          ? ('窗口 "' + state.window + '"' + (state.region ? ' 区域 ' + state.region : ''))
          : (state.region ? '桌面 区域 ' + state.region : '整个桌面'),
        vision: state.vision.model === '' ? '(none)' : state.vision.provider + '/' + state.vision.model,
        entries: state.buffer.length,
        note,
      }
    },
  })

  // ── 工具 2：读短期视觉记忆 ─────────────────────────────────────────────

  own({
    name: 'screen_memory',
    description:
      'Read the rolling short-term screen memory: the recent timeline of what was visible on this machine, transcribed into text by a vision model. Newest entry is last. Use it to learn what the user is doing right now and what just happened on screen.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        minutes: { type: 'number', description: 'How many minutes back to return (default 10, capped by the rolling window).' },
        full: { type: 'boolean', description: 'When true return the full transcript of every entry instead of the default compact view.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['running', 'vision', 'count', 'ticks', 'transcribedFrames', 'skippedFrames', 'busySkips', 'lastError', 'entries'],
        properties: {
          running: { type: 'boolean' },
          vision: { type: 'string' },
          count: { type: 'number' },
          ticks: { type: 'number' },
          transcribedFrames: { type: 'number' },
          skippedFrames: { type: 'number' },
          busySkips: { type: 'number' },
          lastError: { type: 'string' },
          entries: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['at', 'size', 'target', 'truncated', 'text'],
              properties: {
                at: { type: 'string' },
                size: { type: 'string' },
                target: { type: 'string' },
                truncated: { type: 'boolean' },
                text: { type: 'string' },
              },
            },
          },
        },
      },
      render(_args, value) {
        const lines = []
        lines.push('录制中：' + String(value.running) + '，视觉模型 ' + value.vision)
        lines.push(
          '累计抓帧 ' + value.ticks + ' 次；真正转录 ' + value.transcribedFrames +
            ' 帧；因未变化或限流跳过 ' + value.skippedFrames +
            ' 帧；因上一次仍在进行而跳过 ' + value.busySkips + ' 帧。',
        )
        if (value.lastError !== '') lines.push('最近错误：' + value.lastError)
        if (value.entries.length === 0) {
          lines.push('短期记忆为空：可能尚未开始录制，或画面一直没有出现有意义的变化。')
        } else {
          lines.push('--- 短期视觉记忆（由旧到新，共 ' + value.entries.length + ' 条）---')
          for (const entry of value.entries) {
            lines.push('')
            lines.push('[' + entry.at + '] ' + entry.size + (entry.target !== '' ? '  ' + entry.target : '') + (entry.truncated ? '  [被截断]' : ''))
            lines.push(entry.text)
          }
        }
        return textBlock(lines.join('\n'))
      },
    },
    async execute(args) {
      evict()
      const minutes = typeof args?.minutes === 'number' && args.minutes > 0 ? Math.min(args.minutes, 120) : 10
      const full = args?.full === true
      const floor = Date.now() - minutes * 60000
      const entries = []
      for (const entry of state.buffer) {
        if (entry.atMs < floor) continue
        entries.push({
          at: entry.at,
          size: entry.size,
          target: entry.target || '',
          truncated: entry.truncated === true,
          text: full ? entry.text : entry.text.slice(0, 700),
        })
      }
      return {
        running: state.running,
        vision: state.vision.model === '' ? '(none)' : state.vision.provider + '/' + state.vision.model,
        count: entries.length,
        ticks: state.ticks,
        transcribedFrames: state.changed,
        skippedFrames: state.skipped,
        busySkips: state.busySkips,
        lastError: state.lastError,
        entries,
      }
    },
  })

  // ── 工具 3：立刻看一眼（可指定窗口与区域）──────────────────────────────

  own({
    name: 'see_screen',
    description:
      'Take one immediate look at the screen (or at one window, or at one region) and have a vision model report what it is about: main subject first, then notable state, key visual details, and the text actually present. Accuracy improves when the watched area is small, so prefer `window` when the question concerns one application. The result includes suggestedRegion, derived from where the model said the main subject is: pass that value back as `region` for a closer second look.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        focus: { type: 'string', description: 'What to pay attention to, for example a specific dialog, panel, or error message.' },
        window: { type: 'string', description: 'Capture only this window: a process name or a window-title substring, case-insensitive (for example "blender"). Omit to capture the whole desktop.' },
        region: { type: 'string', description: 'Crop as normalized x,y,w,h in 0..1 against the captured area, e.g. "0.45,0.25,0.55,0.75". Use it to zoom in after a first look reported a LOCATION.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'vision', 'target', 'size', 'nonBlack', 'blank', 'summary', 'truncated', 'locationKind', 'suggestedRegion', 'locationNote', 'error', 'imagePath'],
        properties: {
          ok: { type: 'boolean' },
          vision: { type: 'string' },
          target: { type: 'string' },
          size: { type: 'string' },
          nonBlack: { type: 'string' },
          blank: { type: 'boolean' },
          summary: { type: 'string' },
          truncated: { type: 'boolean' },
          locationKind: { type: 'string' },
          suggestedRegion: { type: 'string' },
          locationNote: { type: 'string' },
          error: { type: 'string' },
          imagePath: { type: 'string' },
        },
      },
      render(_args, value) {
        if (!value.ok) {
          const lines = ['看图失败：' + value.error]
          if (value.blank) lines.push('（这张窗口图近乎全黑，说明 PrintWindow 没能渲染这个窗口。可改用不指定 window 的整屏抓取。）')
          return textBlock(lines.join('\n'))
        }
        const lines = []
        lines.push('截图范围：' + value.target + '（' + value.size + '，非黑 ' + value.nonBlack + '%）')
        lines.push('')
        lines.push(value.summary)
        lines.push('')
        lines.push('主体位置解析：' + value.locationKind + ' —— ' + value.locationNote)
        if (value.locationKind !== 'none') {
          lines.push('建议的二次放大 region：' + value.suggestedRegion)
        }
        if (value.truncated) {
          lines.push('⚠️ 本次回答被 token 预算截断，内容可能不完整。')
        }
        lines.push('')
        lines.push('（由 ' + value.vision + ' 转录；原图：' + value.imagePath + '）')
        return textBlock(lines.join('\n'))
      },
    },
    async execute(args) {
      const focus = typeof args?.focus === 'string' ? args.focus : ''
      const windowQuery = typeof args?.window === 'string' ? args.window.trim() : ''
      const region = typeof args?.region === 'string' ? args.region.trim() : ''
      const result = await tick(true, focus, windowQuery, region)
      return {
        ok: result.transcribed === true,
        vision: state.vision.model === '' ? '(none)' : state.vision.provider + '/' + state.vision.model,
        target: result.target,
        size: result.size,
        nonBlack: result.nonBlack,
        blank: result.blank === true,
        summary: result.summary,
        truncated: result.truncated === true,
        locationKind: result.locationKind,
        suggestedRegion: result.suggestedRegion,
        locationNote: result.locationNote,
        error: result.error !== '' ? result.error : result.transcribed ? '' : result.reason || 'no transcription',
        imagePath: state.lastPath,
      }
    },
  })

  // ── 工具 4：视觉路由探测 ───────────────────────────────────────────────

  own({
    name: 'vision_routes',
    description: 'Probe every registered LLM provider route and report which provider/model combos declare image input support.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'number', description: 'Maximum number of model routes to inspect in total (default 24).' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'note', 'scanned', 'imageCapable', 'routes'],
        properties: {
          ok: { type: 'boolean' },
          note: { type: 'string' },
          scanned: { type: 'number' },
          imageCapable: { type: 'number' },
          routes: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['provider', 'model', 'modalities', 'image', 'note'],
              properties: {
                provider: { type: 'string' },
                model: { type: 'string' },
                modalities: { type: 'string' },
                image: { type: 'boolean' },
                note: { type: 'string' },
              },
            },
          },
        },
      },
      render(_args, value) {
        const lines = ['扫描 ' + value.scanned + ' 条路由，可看图 ' + value.imageCapable + ' 条。']
        for (const route of value.routes) {
          lines.push((route.image ? '[可看图] ' : '[不看图] ') + route.provider + ' / ' + route.model + (route.note !== '' ? ' -- ' + route.note : ''))
        }
        return textBlock(lines.join('\n'))
      },
    },
    async execute(args) {
      const llm = ctx.get('llm')
      if (llm === undefined || llm === null) return { ok: false, note: 'llm unavailable', scanned: 0, imageCapable: 0, routes: [] }
      const cap = typeof args?.limit === 'number' && args.limit > 0 ? Math.min(args.limit, 60) : 24
      const routes = []
      let imageCapable = 0
      let note = ''
      let providers = []
      try {
        providers = await llm.listProviders()
      } catch (error) {
        return { ok: false, note: errText(error), scanned: 0, imageCapable: 0, routes: [] }
      }
      for (const provider of providers) {
        if (routes.length >= cap) {
          note = 'reached limit'
          break
        }
        const pid = provider !== undefined && provider !== null ? String(provider.id || '') : ''
        if (pid === '') continue
        let models = []
        try {
          models = await llm.listModels(pid)
        } catch (error) {
          routes.push({ provider: pid, model: '(listModels failed)', modalities: '', image: false, note: errText(error).slice(0, 120) })
          continue
        }
        for (const model of models) {
          if (routes.length >= cap) {
            note = 'reached limit'
            break
          }
          const mid = model !== undefined && model !== null ? String(model.id || '') : ''
          if (mid === '') continue
          try {
            const info = await llm.resolveModelInfo(pid, mid)
            const raw = info !== undefined && info !== null && Array.isArray(info.inputModalities) ? info.inputModalities : []
            const image = raw.map(String).includes('image')
            if (image) imageCapable += 1
            routes.push({ provider: pid, model: mid, modalities: raw.map(String).join(','), image, note: '' })
          } catch (error) {
            routes.push({ provider: pid, model: mid, modalities: '', image: false, note: errText(error).slice(0, 120) })
          }
        }
      }
      return { ok: true, note, scanned: routes.length, imageCapable, routes }
    },
  })

  // ── 生命周期：插件一停，定时器、记忆、最后一张截图一起消失 ──────────────

  ctx.effect(() => () => {
    if (state.timer !== null) {
      state.timer()
      state.timer = null
    }
    state.running = false
    state.buffer = []
    state.prevSig = ''
    runCaptureCli(['-Mode', 'cleanup'], 10000).catch(() => {})
  })
}
