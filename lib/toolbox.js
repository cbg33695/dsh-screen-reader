// vision-toolbox — 图片文件视角的工具集（preset 平面，与 see-screen 并列的一行）。
//
// 【为什么和 see-screen 分开】
//   see-screen 管"看屏幕"（持续录制、滚动记忆）；这个文件管"看图片文件"
//   （看一张图、比两张图、自校准、附件库治理）。两者生命周期和改动节奏不同，
//   分开可以让其中一个换文件名绕模块缓存时不动另一个。
//
// 【和 see-screen 的重复是刻意的】
//   加载器的规则决定了插件不能被裸包名依赖，而相对 import 会把两个插件的
//   生命周期绑在一起（一个改名另一个就断）。所以这里重复了约 40 行提示词与
//   错误处理。**修改提示词时两处都要改** —— 这是已知代价，不是疏忽。
//
// 【四个工具】
//   see_image       看一张图片文件
//   see_diff        两张图的差异：本地精确差分定位区域 → 只把变化区域交给模型解释
//   vision_selftest 自校准：画一张每项事实都确定的图 + 施加已知改动 → 喂给模型 →
//                   拿它的回答和已知真值逐项比对打分。**这是把"准不准"从主观
//                   变成数字的唯一手段。**
//   vision_storage  附件库的规模报告与可选清理
//
// 【差分为什么不让模型去看两张原图】
//   视觉模型做细粒度找茬很差，而且会编造"看起来合理"的差异。像素级差分是精确的、
//   免费的、还能给出变化区域的边界框。所以分工是：**本地算差异，模型只解释差异。**

import { fileURLToPath } from 'node:url'

const name = 'vision-toolbox'


const OPS_SCRIPT = fileURLToPath(new URL('imageops.ps1', import.meta.url))

const VISION_TOKENS = 6000
const VISION_TOKENS_RETRY = 14000
const VISION_PROVIDER_HINT = 'deepseek-official'
const VISION_MODEL_HINT = 'deepseek-v4-flash-vision-exp'

const VISION_SYSTEM = [
  '你是屏幕与图像分析引擎。你的任务是准确读出画面里的信息，绝对不要猜测或补全。',
  '铁律：',
  '1. 先看整体再看细节。在转录任何界面文字之前，必须先确定画面主体。',
  '2. 逐字转录。代码、路径、命令行、ID、数字、报错信息必须原样照抄，不修正、不翻译。',
  '3. 看不清的地方写 [?]，不要编造。宁可留空也不猜。',
  '4. 不确定就说不确定。只存在于你推测里的东西不要写成看到的东西。',
  '5. 不要做建议、不要评价、不要客套。',
  '6. 直接给出结果，不要展示思考过程。',
  '7. 格式要求必须逐字遵守。',
].join('\n')

const VISION_PROMPT = [
  '请严格按下面的顺序输出四个小标题，不要添加其它内容。',
  '',
  '【主体】这是最重要的一项，必须最先回答。',
  '先用一句话直接说明：这张图的主体是什么？',
  '判断规则：只有一个明显主体时直接说出它是什么；有多个并列主体时全部列出，',
  '不要硬凑成一个；没有明确主体时必须直接写"没有单一主体"，然后说明实际看到什么。',
  '然后补充 2-4 句：主体的形态与构成。',
  '',
  '【状态】有无被选中、高亮、置灰、报错等状态。没有就写"无异常状态"。',
  '',
  '【细节】关键元素的位置（上/下/左/右/中）、颜色、相对大小。',
  '若存在被编辑过的非标准形状、或被选中/高亮的物体，必须特别指出。',
  '',
  '【文字】逐字转录画面中确实存在的文字。没有文字就写"画面中没有文字"。',
].join('\n')

// 只用来解释"已知存在"的差异，所以任务不是找茬而是描述。
const DIFF_SYSTEM = [
  '你是图像差异描述引擎。你的任务是说明两张图之间**确实存在**的差异。',
  '铁律：',
  '1. 只描述你真实看到的差异，不要推测意图，不要编造差异。',
  '2. 看不清就写 [?]，不要猜。',
  '3. 逐字转录涉及的文字变化（例如某个数字从 180 变成 90），原样照抄。',
  '4. 不要做建议、不要评价、不要客套。直接给结果，不要展示思考过程。',
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

function pickAll(text, prefix) {
  const out = []
  for (const line of String(text || '').split(/\r?\n/)) {
    if (line.startsWith(prefix)) out.push(line.slice(prefix.length).trim())
  }
  return out
}

// imageops.ps1 emits `REGION=<i>|<x>|<y>|<w>|<h>|<changedPixels>` once per region,
// all sharing the same `REGION=` prefix -- so the region index has to be matched on
// the first field. pick() alone would always return region 1.
function regionLine(text, index) {
  const want = String(index)
  for (const line of pickAll(text, 'REGION=')) {
    if (String(line.split('|')[0]).trim() === want) return line
  }
  return ''
}

const textBlock = (text) => [{ type: 'text', text }]

const jsonObject = (properties, required) => ({ type: 'object', additionalProperties: false, properties, required })

export function install(ctx) {
  const state = { vision: { provider: '', model: '', resolved: false, error: '' } }

  // 用 argv 数组调用 PowerShell，与 see-screen 同一套路：绕开 shell 引号问题。
  async function runOps(args, timeoutMs) {
    const notes = []
    const subprocess = ctx.get('subprocess')
    const policy = ctx.get('sandboxPolicy')
    const cwd = policy !== undefined && policy !== null && typeof policy.workspaceRoot === 'string' ? policy.workspaceRoot : ''

    if (subprocess !== undefined && subprocess !== null && cwd !== '') {
      try {
        const exe = await subprocess.resolveExecutable('powershell.exe')
        const handle = subprocess.spawn({
          argv: [exe, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', OPS_SCRIPT].concat(args),
          cwd,
          stdio: { stdin: 'ignore', stdout: { maxBytes: 2097152 }, stderr: { maxBytes: 65536 } },
          graceMs: 8000,
        })
        await handle.done
        const reader = handle.collected !== undefined ? handle.collected.stdout : undefined
        const text = reader !== undefined ? String(reader.readFrom(0).text || '') : ''
        if (text.includes('ERR=') || text.includes('PATH=') || text.includes('SIZE=') || text.trim() === '') {
          return { ok: true, text, notes }
        }
        const errReader = handle.collected !== undefined ? handle.collected.stderr : undefined
        notes.push('no payload; stderr=' + (errReader !== undefined ? String(errReader.readFrom(0).text || '').slice(0, 300) : ''))
      } catch (error) {
        notes.push('subprocess failed: ' + errText(error).slice(0, 250))
      }
    } else {
      notes.push('subprocess or sandboxPolicy unavailable')
    }

    const shell = ctx.get('shell')
    if (shell !== undefined && shell !== null) {
      try {
        const quote = (value) => "'" + String(value).replace(/'/g, "''") + "'"
        const line = ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', quote(OPS_SCRIPT)]
          .concat(args.map(quote))
          .join(' ')
        const spec = shell.resolve({ command: line, timeoutMs, stdoutMaxBytes: 2097152 })
        const run = await shell.run(spec)
        const stdout = run !== undefined && run.stdout !== undefined ? String(run.stdout.text || '') : ''
        if (stdout.includes('ERR=') || stdout.includes('PATH=') || stdout.includes('SIZE=')) {
          return { ok: true, text: stdout, notes }
        }
        notes.push('shell produced no payload')
      } catch (error) {
        notes.push('shell failed: ' + errText(error).slice(0, 250))
      }
    }
    return { ok: false, text: '', notes }
  }

  async function resolveVision() {
    if (state.vision.resolved) return state.vision
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

  async function readFileBytes(path) {
    const fs = ctx.get('fs')
    if (fs === undefined || fs === null) throw new Error('fs service unavailable')
    const target = await fs.resolve(path)
    const bytes = await fs.readBytes(target, undefined, 33554432)
    if (bytes === undefined || bytes === null || bytes.length === 0) throw new Error('file is empty or unreadable: ' + path)
    return bytes
  }

  function mediaTypeOf(path) {
    const lower = String(path).toLowerCase()
    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
    if (lower.endsWith('.webp')) return 'image/webp'
    if (lower.endsWith('.gif')) return 'image/gif'
    return 'image/png'
  }

  // 一次模型调用；空正文不是成功，翻倍重试，仍有推理就返回推理。
  async function askVision(images, prompt, system) {
    const route = await resolveVision()
    if (route.model === '') throw new Error('no vision route: ' + route.error)
    const attachments = ctx.get('attachments')
    const llm = ctx.get('llm')
    if (attachments === undefined || attachments === null) throw new Error('attachments service unavailable')
    if (llm === undefined || llm === null) throw new Error('llm service unavailable')

    const refs = []
    for (const image of images) {
      // 每次调用都会往附件库新增一个文件，且不会自动清理。见 vision_storage。
      refs.push(await attachments.saveImage({ data: image.bytes, mediaType: mediaTypeOf(image.path), name: image.name || 'image.png' }))
    }
    const imageBlocks = []
    for (const ref of refs) imageBlocks.push({ type: 'image', attachment: ref })

    const run = async (text, budget) => {
      const stream = llm.stream({
        provider: route.provider,
        model: route.model,
        system,
        maxTokens: budget,
        messages: [
          {
            id: 'toolbox-call',
            role: 'user',
            source: { kind: 'plugin', plugin: name },
            content: imageBlocks.concat([{ type: 'text', text }]),
          },
        ],
      })
      let out = ''
      let reasoning = ''
      let finish = '(none)'
      for await (const chunk of stream) {
        if (chunk === undefined || chunk === null) continue
        const kind = String(chunk.type || '')
        if (kind === 'text-delta') out += String(chunk.text || '')
        else if (kind === 'reasoning-delta') reasoning += String(chunk.text || '')
        else if (kind === 'finish' && chunk.reason !== undefined && chunk.reason !== null) {
          finish = String(chunk.reason.kind || '?')
          if (chunk.reason.failure !== undefined && chunk.reason.failure !== null) {
            throw new Error(String(chunk.reason.failure.message || chunk.reason.failure.code || 'model error'))
          }
        }
      }
      return { text: out.trim(), reasoning, finish }
    }

    const first = await run(prompt, VISION_TOKENS)
    if (first.text !== '') return { text: first.text, truncated: first.finish === 'max-tokens', finish: first.finish, retried: false }
    let second = null
    try {
      second = await run(prompt + '\n\n重要：请直接输出结论，不要展开思考过程。', VISION_TOKENS_RETRY)
    } catch {
      second = null
    }
    if (second !== null && second.text !== '') return { text: second.text, truncated: second.finish === 'max-tokens', finish: second.finish, retried: true }
    const reasoning = second !== null && second.reasoning.length > first.reasoning.length ? second.reasoning : first.reasoning
    if (reasoning !== '') {
      return { text: '[正文被截断：只产出推理过程]\n' + reasoning.slice(0, 6000), truncated: true, finish: first.finish + ' (reasoning-only)', retried: second !== null }
    }
    throw new Error('model produced no output (finish=' + first.finish + ')')
  }

  function own(tool) {
    ctx.effect(() => ctx.tools.register(tool))
  }

  // ── 工具 1：看一张图片文件 ─────────────────────────────────────────────

  own({
    name: 'see_image',
    description:
      'Look at one image FILE (not the screen): read it from disk and have a vision model report the main subject first, then notable state, visual details, and the text actually present. Use it for a chart, a design mockup, a screenshot someone sent, or any image the user names.',
    parameters: jsonObject({
      path: { type: 'string', description: 'Absolute path of the image file to look at.' },
      focus: { type: 'string', description: 'What to pay attention to, in one sentence.' },
    }, ['path']),
    output: {
      schema: jsonObject({
        ok: { type: 'boolean' },
        vision: { type: 'string' },
        bytes: { type: 'number' },
        truncated: { type: 'boolean' },
        answer: { type: 'string' },
        error: { type: 'string' },
      }, ['ok', 'vision', 'bytes', 'truncated', 'answer', 'error']),
      render(args, value) {
        if (!value.ok) return textBlock('看图失败（' + args.path + '）：' + value.error)
        const lines = ['【' + args.path + '】' + value.bytes + ' 字节，由 ' + value.vision + ' 分析：', '', value.answer]
        if (value.truncated) lines.push('', '⚠️ 回答被 token 预算截断。')
        return textBlock(lines.join('\n'))
      },
    },
    async execute(args) {
      const base = { ok: false, vision: '', bytes: 0, truncated: false, answer: '', error: '' }
      const path = String(args?.path || '')
      if (path === '') { base.error = 'path is required'; return base }
      let bytes = null
      try {
        bytes = await readFileBytes(path)
      } catch (error) {
        base.error = errText(error)
        return base
      }
      base.bytes = bytes.length
      const focus = typeof args?.focus === 'string' && args.focus.length > 0 ? args.focus : ''
      try {
        const out = await askVision([{ path, bytes, name: 'file.png' }], focus ? VISION_PROMPT + '\n\n特别注意（调用方关注点）：' + focus : VISION_PROMPT, VISION_SYSTEM)
        return { ok: true, vision: state.vision.provider + '/' + state.vision.model, bytes: bytes.length, truncated: out.truncated, answer: out.text, error: '' }
      } catch (error) {
        return { ok: false, vision: '', bytes: bytes.length, truncated: false, answer: '', error: errText(error) }
      }
    },
  })

  // ── 工具 2：两张图的差异 ───────────────────────────────────────────────

  own({
    name: 'see_diff',
    description:
      'Compare two images: compute an exact pixel-level difference locally to locate the changed regions, then have a vision model explain ONLY those changed regions. Use it for before/after screenshots, a mockup versus an implementation, or any two images that should match. The local diff is exact; the model only describes what the diff already proved changed.',
    parameters: jsonObject({
      pathA: { type: 'string', description: 'Absolute path of the BEFORE image.' },
      pathB: { type: 'string', description: 'Absolute path of the AFTER image.' },
      focus: { type: 'string', description: 'What to pay attention to, in one sentence.' },
      maxRegions: { type: 'number', description: 'How many of the largest changed regions to describe (default 2, max 4).' },
    }, ['pathA', 'pathB']),
    output: {
      schema: jsonObject({
        ok: { type: 'boolean' },
        size: { type: 'string' },
        changedPixels: { type: 'number' },
        changedPct: { type: 'string' },
        regionCount: { type: 'number' },
        regions: { type: 'string' },
        described: { type: 'number' },
        model: { type: 'string' },
        answer: { type: 'string' },
        error: { type: 'string' },
      }, ['ok', 'size', 'changedPixels', 'changedPct', 'regionCount', 'regions', 'described', 'model', 'answer', 'error']),
      render(_args, value) {
        if (!value.ok) return textBlock('差分失败：' + value.error)
        const lines = []
        lines.push('本地精确差分（0 token）：')
        lines.push('  尺寸 ' + value.size + '，变化像素 ' + value.changedPixels + '（' + value.changedPct + '%），连通区域 ' + value.regionCount + ' 个')
        if (value.regions !== '') {
          lines.push('  区域（按变化量降序，x|y|w|h|变化像素）：')
          for (const line of value.regions.split('\n')) lines.push('    ' + line)
        }
        lines.push('')
        if (value.described === 0) {
          lines.push('两张图在此阈值下没有可报告的变化。')
        } else {
          lines.push('由 ' + value.model + ' 解释前 ' + value.described + ' 个变化区域：')
          lines.push('')
          lines.push(value.answer)
        }
        return textBlock(lines.join('\n'))
      },
    },
    async execute(args) {
      const base = { ok: false, size: '', changedPixels: 0, changedPct: '', regionCount: 0, regions: '', described: 0, answer: '', error: '', model: '' }
      const a = String(args?.pathA || '')
      const b = String(args?.pathB || '')
      if (a === '' || b === '') { base.error = 'pathA and pathB are both required'; return base }

      const run = await runOps(['-Mode', 'diff', '-A', a, '-B', b], 90000)
      if (!run.ok) { base.error = run.notes.join(' | '); return base }
      const failure = pick(run.text, 'ERR=')
      if (failure !== '') { base.error = failure; return base }

      base.ok = true
      base.size = pick(run.text, 'SIZE=')
      base.changedPixels = Number(pick(run.text, 'CHANGEDPIXELS=')) || 0
      base.changedPct = pick(run.text, 'CHANGEDPCT=')
      base.regionCount = Number(pick(run.text, 'REGIONCOUNT=')) || 0
      const regionLines = pickAll(run.text, 'REGION=').map((line) => line.replace(/\|/g, ' | '))
      base.regions = regionLines.join('\n')
      base.model = state.vision.model === '' ? '(未解析)' : state.vision.provider + '/' + state.vision.model

      if (base.regionCount === 0) return base

      const want = typeof args?.maxRegions === 'number' && args.maxRegions > 0 ? Math.min(args.maxRegions, 4) : 2
      const pairs = []
      for (let i = 1; i <= want; i += 1) {
        const cropA = pick(run.text, 'CROPA_' + i + '=')
        const cropB = pick(run.text, 'CROPB_' + i + '=')
        if (cropA === '' || cropB === '') break
        pairs.push({ region: regionLine(run.text, i), a: cropA, b: cropB })
      }
      if (pairs.length === 0) return base

      const focus = typeof args?.focus === 'string' && args.focus.length > 0 ? args.focus : ''
      const answers = []
      for (const pair of pairs) {
        try {
          const bytesA = await readFileBytes(pair.a)
          const bytesB = await readFileBytes(pair.b)
          const prompt = [
            '下面两张图是同一个区域在改动前后的对比。',
            '第一张是【改动前】，第二张是【改动后】。',
            '像素级差分已经确认这个区域确实发生了改变，所以不需要判断"有没有变化"，',
            '只需要说明**发生了什么变化**：形状、颜色、位置、数量、文字（逐字照抄）。',
            focus ? '\n特别注意（调用方关注点）：' + focus : '',
          ].join('\n')
          const out = await askVision(
            [
              { path: pair.a, bytes: bytesA, name: 'before.png' },
              { path: pair.b, bytes: bytesB, name: 'after.png' },
            ],
            prompt,
            DIFF_SYSTEM,
          )
          answers.push('区域 ' + pair.region.replace(/\|/g, ' | ') + '\n' + out.text)
        } catch (error) {
          answers.push('区域 ' + pair.region.replace(/\|/g, ' | ') + '\n（解释失败：' + errText(error) + '）')
        }
      }
      base.described = pairs.length
      base.answer = answers.join('\n\n')
      return base
    },
  })

  // ── 工具 3：自校准（把"准不准"变成数字）────────────────────────────────

  own({
    name: 'vision_selftest',
    description:
      'Run a self-calibration of the vision pipeline against KNOWN ground truth: draw an image whose every fact is fixed by construction, apply a known set of changes, let the local diff locate them, and let the vision model describe them. Returns the expected changes, the detected regions, the model answer, and a keyword-based score. Use it to measure whether the pipeline is accurate instead of judging by feel.',
    parameters: jsonObject({
      full: { type: 'boolean', description: 'When true return the whole model answer instead of a trimmed one.' },
    }, []),
    output: {
      schema: jsonObject({
        ok: { type: 'boolean' },
        baseline: { type: 'string' },
        mutated: { type: 'string' },
        expected: { type: 'string' },
        changedPixels: { type: 'number' },
        regionCount: { type: 'number' },
        score: { type: 'string' },
        answer: { type: 'string' },
        error: { type: 'string' },
      }, ['ok', 'baseline', 'mutated', 'expected', 'changedPixels', 'regionCount', 'score', 'answer', 'error']),
      render(_args, value) {
        if (!value.ok) return textBlock('自校准失败：' + value.error)
        const lines = ['=== 自校准 ===', '']
        lines.push('基准图 : ' + value.baseline)
        lines.push('改动图 : ' + value.mutated)
        lines.push('本地差分：变化像素 ' + value.changedPixels + '，连通区域 ' + value.regionCount + ' 个')
        lines.push('')
        lines.push('已知改动（真值）：')
        lines.push(value.expected)
        lines.push('')
        lines.push('关键词打分：' + value.score)
        lines.push('')
        lines.push('模型回答：')
        lines.push(value.answer)
        return textBlock(lines.join('\n'))
      },
    },
    async execute(args) {
      const base = { ok: false, baseline: '', mutated: '', expected: '', changedPixels: 0, regionCount: 0, score: '', answer: '', error: '' }
      const full = args?.full === true

      const draw = await runOps(['-Mode', 'calib-draw'], 60000)
      if (!draw.ok) { base.error = 'calib-draw: ' + draw.notes.join(' | '); return base }
      const mut = await runOps(['-Mode', 'calib-bad'], 60000)
      if (!mut.ok) { base.error = 'calib-bad: ' + mut.notes.join(' | '); return base }

      base.baseline = pick(draw.text, 'PATH=')
      base.mutated = pick(mut.text, 'PATH=')
      base.expected = pickAll(mut.text, 'EXPECTED=').join('\n')
      const drawErr = pick(draw.text, 'ERR=')
      const mutErr = pick(mut.text, 'ERR=')
      if (drawErr !== '' || mutErr !== '') { base.error = drawErr || mutErr; return base }
      if (base.baseline === '' || base.mutated === '') { base.error = 'calibration images were not written'; return base }

      const diff = await runOps(['-Mode', 'diff', '-A', base.baseline, '-B', base.mutated], 90000)
      const diffErr = pick(diff.text, 'ERR=')
      if (diffErr !== '') { base.error = 'diff: ' + diffErr; return base }
      base.changedPixels = Number(pick(diff.text, 'CHANGEDPIXELS=')) || 0
      base.regionCount = Number(pick(diff.text, 'REGIONCOUNT=')) || 0

      const pairs = []
      for (let i = 1; i <= 4; i += 1) {
        const cropA = pick(diff.text, 'CROPA_' + i + '=')
        const cropB = pick(diff.text, 'CROPB_' + i + '=')
        if (cropA === '' || cropB === '') break
        pairs.push({ a: cropA, b: cropB })
      }

      const answers = []
      try {
        for (const pair of pairs) {
          const bytesA = await readFileBytes(pair.a)
          const bytesB = await readFileBytes(pair.b)
          const out = await askVision(
            [
              { path: pair.a, bytes: bytesA, name: 'before.png' },
              { path: pair.b, bytes: bytesB, name: 'after.png' },
            ],
            [
              '下面两张图是同一个区域在改动前后的对比。第一张是【改动前】，第二张是【改动后】。',
              '像素级差分已确认这个区域确实改变了，所以只需要说明**发生了什么变化**：',
              '形状、颜色、位置、数量、以及文字（逐字照抄，尤其数字）。',
            ].join('\n'),
            DIFF_SYSTEM,
          )
          answers.push(out.text)
        }
      } catch (error) {
        base.error = 'vision: ' + errText(error)
      }
      const joined = answers.join('\n')

      // 关键词打分：故意做得保守，只有明确命中才算。它只是启发式，
      // 所以原始回答一并返回，便于人工复核。
      const checks = [
        { name: '标题文字 CAL-7F3A -> CAL-7F3B', hit: /7F3B|7f3b/.test(joined) },
        { name: '红圆从左上方移到右下方', hit: /(圆|circle|ellipse)/i.test(joined) && /(右|right|移|moved|移动|corner|角)/i.test(joined) },
        { name: 'C 柱数值 180 -> 90', hit: /180/.test(joined) && /90/.test(joined) },
        { name: '底部黄条消失', hit: /(黄|yellow|band|条)/i.test(joined) && /(消失|不见|删除|移除|gone|removed|missing|absent)/i.test(joined) },
      ]
      const hit = checks.filter((c) => c.hit).length
      base.score = hit + ' / ' + checks.length + ' 项命中' + (checks.map((c) => (c.hit ? ' ✓ ' : ' ✗ ') + c.name).join('；'))
      base.ok = true
      base.answer = full ? joined : joined.slice(0, 4000)
      return base
    },
  })

  // ── 工具 4：附件库治理 ────────────────────────────────────────────────

  own({
    name: 'vision_storage',
    description:
      'Report the size of the DSH attachment store, which grows by one content-addressed file on EVERY vision call and never prunes itself. Optionally delete files older than a given number of days. WARNING: historical sessions reference those files, so pruning can break image rendering in past conversations. Report-only unless pruneDays is given explicitly.',
    parameters: jsonObject({
      pruneDays: { type: 'number', description: 'When > 0, delete attachment files older than this many days. Omit to report only.' },
    }, []),
    output: {
      schema: jsonObject({
        ok: { type: 'boolean' },
        root: { type: 'string' },
        count: { type: 'number' },
        bytes: { type: 'number' },
        oldest: { type: 'string' },
        newest: { type: 'string' },
        deleted: { type: 'number' },
        deletedBytes: { type: 'number' },
        error: { type: 'string' },
      }, ['ok', 'root', 'count', 'bytes', 'oldest', 'newest', 'deleted', 'deletedBytes', 'error']),
      render(_args, value) {
        if (!value.ok) return textBlock('附件库查询失败：' + value.error)
        const lines = []
        lines.push('附件库：' + value.root)
        lines.push('  文件数 ' + value.count + '，共 ' + (value.bytes / 1048576).toFixed(2) + ' MB')
        if (value.oldest !== '') lines.push('  最早 ' + value.oldest + '，最新 ' + value.newest)
        if (value.deleted > 0) lines.push('  已删除 ' + value.deleted + ' 个文件（' + (value.deletedBytes / 1048576).toFixed(2) + ' MB）')
        lines.push('')
        lines.push('提醒：这些文件被历史会话引用，删除后过去对话里的图片可能无法再显示。')
        return textBlock(lines.join('\n'))
      },
    },
    async execute(args) {
      const base = { ok: false, root: '', count: 0, bytes: 0, oldest: '', newest: '', deleted: 0, deletedBytes: 0, error: '' }
      const days = typeof args?.pruneDays === 'number' && args.pruneDays > 0 ? Math.floor(args.pruneDays) : 0
      const cli = ['-Mode', 'storage']
      if (days > 0) cli.push('-PruneDays', String(days))
      const run = await runOps(cli, 60000)
      if (!run.ok) { base.error = run.notes.join(' | '); return base }
      const failure = pick(run.text, 'ERR=')
      if (failure !== '') { base.error = failure; return base }
      base.ok = true
      base.root = pick(run.text, 'ROOT=')
      base.count = Number(pick(run.text, 'COUNT=')) || 0
      base.bytes = Number(pick(run.text, 'BYTES=')) || 0
      base.oldest = pick(run.text, 'OLDEST=')
      base.newest = pick(run.text, 'NEWEST=')
      base.deleted = Number(pick(run.text, 'DELETED=')) || 0
      base.deletedBytes = Number(pick(run.text, 'DELETEDBYTES=')) || 0
      return base
    },
  })
}
