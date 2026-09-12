// vision-toolbox — 差分工具（preset 平面，与 see-screen 并列的一行）。
//
// 【为什么和 see-screen 分开】
//   see-screen 管"看屏幕"（抓一张，交给当前模型看）；这个文件管"比两张图"。
//   两者生命周期和改动节奏不同，分开可以让其中一个换文件名绕模块缓存时不动另一个。
//
// 【和 see-screen 的重复是刻意的】
//   加载器的规则决定了插件不能被裸包名依赖，而相对 import 会把两个插件的
//   生命周期绑在一起（一个改名另一个就断）。所以这里重复了约 40 行视觉路由与
//   错误处理。**修改那部分时两处都要改** —— 这是已知代价，不是疏忽。
//
// 【唯一的工具】
//   see_diff  两张图的差异：本地精确像素差分定位变化区域 → 只把变化区域交给
//             视觉模型解释。分工的理由见文件末的说明：模型做细粒度找茬很差
//             且会编造，所以"有没有变、变在哪"由本地算，模型只回答"变成了什么"。
//
// 【被删掉的东西，以及为什么】
//   see_image       读一个图片文件让模型描述 —— 就是内置 `read_image` 的较差重复
//   vision_selftest 自校准打分 —— 从未跑过，且只覆盖差分链，没有覆盖 see_screen
//   vision_storage  附件库报告/清理 —— 诊断件，不是能力

//
// 【差分为什么不让模型去看两张原图】
//   视觉模型做细粒度找茬很差，而且会编造"看起来合理"的差异。像素级差分是精确的、
//   免费的、还能给出变化区域的边界框。所以分工是：**本地算差异，模型只解释差异。**

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const name = 'vision-toolbox'


// ps1 助手在两种布局里的位置不同：
//   agent preset → 与本文件同目录（plugin/toolbox.js 与 plugin/imageops.ps1）
//   发布包        → 本文件在 lib/，助手在 scripts/
// 同 screen.js：不在打包时重写这一行，改成运行期两种位置都试，否则一旦打包脚本
// 忘了改就会像 0.2.0 那样发布出一个找不到 ps1 的包。
function resolveHelper(fileName) {
  const beside = fileURLToPath(new URL(fileName, import.meta.url))
  if (existsSync(beside)) return beside
  const packaged = fileURLToPath(new URL('../scripts/' + fileName, import.meta.url))
  if (existsSync(packaged)) return packaged
  return beside
}

const OPS_SCRIPT = resolveHelper('imageops.ps1')

const VISION_TOKENS = 6000
const VISION_TOKENS_RETRY = 14000
const VISION_PROVIDER_HINT = 'deepseek-official'
const VISION_MODEL_HINT = 'deepseek-v4-flash-vision-exp'

// VISION_SYSTEM / VISION_PROMPT 随 `see_image` 一起删除：它们只被那一个工具使用。
// see_diff 与 vision_selftest 各自带自己的提示词（见 DIFF_SYSTEM），所以这两个常量
// 删掉后没有任何引用方，留着只会让后来的人以为主视觉路径的提示词在这里。

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

  // `see_image` 曾被删在这里。它做的事是"读一个图片文件，让视觉模型描述它"——
  // 这正是内置 `read_image` 做的事，而且内置的那个维护得更好、参数校验更完整。
  // 留着它等于给同一件事写了两套文档，还多一层模型间转述。所以删掉，不改成
  // 直传图像：真要直传图像，内置工具已经在那儿了。

  // ── 唯一的工具：两张图的差异 ───────────────────────────────────────────────

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

}
