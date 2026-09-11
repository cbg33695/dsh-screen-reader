# dsh-screen-reader

> A DeepSeek Harness plugin that lets a **text-only model see the screen**.
> Capture the desktop / one window / one region → a vision model transcribes it → keep a few minutes of rolling screen memory → compute exact local pixel diffs → and self-calibrate the vision pipeline against known ground truth.
>
> **Windows only.** Requires PowerShell 5.1 with `System.Drawing` and `PrintWindow`.

README in Chinese: [README.md](README.md)

---

## ⚠️ Read this first: when you should NOT use this plugin

| Your need | Better choice |
|---|---|
| I just want to paste an image and ask about it | Use [`@liustack/modlens`](https://www.dsh.so/artifact/modlens/) (★3.9k, L5 run-tested, Gold trust, structured JSON output). **It is more mature at that job and this plugin does not try to compete there.** |
| My session model already accepts image input | Use the built-in `read_image` and image attachments — half of this plugin exists only to bridge text-only models |
| I need cross-platform | This plugin is Windows-only |
| I need precise pixel measurement | Use a real measuring tool. This is a **describer**, and measured size error reaches ±40% |

**The one thing this plugin does that nothing else covers is continuous screen memory** — "let the agent know what you were just doing", rather than "what is in this image".

---

## The eight tools

**Screen**

| Tool | Purpose |
|---|---|
| `see_screen` | One immediate look. Supports `window` (a process name or title substring) and `region` (normalized crop). Returns a parsed `suggestedRegion` you can pass straight back for a closer second look |
| `screen_watch` | Start/stop continuous change-driven recording. **Off by default**; requires an explicit `{ on: true }` |
| `screen_memory` | Read the rolling short-term visual memory |
| `vision_routes` | Report which model routes declare image input support |

**Image files**

| Tool | Purpose |
|---|---|
| `see_image` | Look at one image file (chart, mockup, a screenshot someone sent) |
| `see_diff` | Two images: **an exact local pixel diff locates the changed regions, then the model explains only those** |
| `vision_selftest` | Self-calibration: draw an image whose every fact is known by construction, apply known edits, have the model describe them, score against the known truth |
| `vision_storage` | Report (and optionally prune) the DSH attachment store |

---

## Measured effects

Everything below was measured on real runs, not designed.

### Vision

| Item | Result |
|---|---|
| Read a bar chart (synthetic, 4 bars) | **4/4 exact** (120 / 60 / 180 / 90); colours and ordering correct |
| Read the Blender Outliner object list | **4/4** (`Camera / Cube / Light / 球体`) — identical to the ground truth dumped by headless Blender |
| Read a title bar with a Chinese path | Character-for-character correct |
| Identify which object is selected | **0/3 before the prompt rewrite → 2/2 after** |
| Structured `LOCATION` output | **2/2 emitted** as specified, and parsed into a usable `region` |

### Local pixel diff (the most reliable part of the plugin)

| Item | Result |
|---|---|
| A real 1225×1254 JPEG with 2 programmatic edits | **Exactly 2 regions detected, zero false positives** |
| Positional accuracy | Bounding boxes ~30–45 px larger than the true edits (= padding 10 + grid quantisation + dilation 1) |
| An image compared with itself | 0 changed pixels, correctly reports "no change" |
| The synthetic calibration pair (4 known edits) | All 4 found; two of them merge into one region because of dilation (a known tradeoff) |

### Cost and failure semantics

| Item | Result |
|---|---|
| Reasoning-token consumption | ~790 for a simple synthetic image; over 6000 for a full Blender window |
| Silent empty-output failure | **Reproduced, then fixed**: the same image at a 1200 budget returned 0 text characters with `finish=max-tokens`, and the old code reported it as success |
| Current behaviour on empty text | Retry once at double budget → fall back to returning the reasoning with an explicit truncation warning → only error out if everything is empty. **Never an empty "success"** |

---

## Boundaries: what it cannot do

This is the most important section of this document.

### 1. It is a describer, not a measuring instrument

Measured: a **30 px** tall colour band was read as "40–45 px" — **about 40% error**.

- Reliable: which is taller, what is greyed out, roughly upper-left or lower-right
- Unreliable: are these two elements 8 px apart, is this gap 16 or 12

### 2. Low-contrast differences are the danger zone

The easy case works (a grey versus a saturated-blue "disabled" button is not hard). The genuinely hard cases — two similar greys, a 1 px misalignment, a faint colour shift — are exactly where it misses, or **worse, confidently invents something**. And "look at my UI and tell me what is wrong" needs precisely those.

### 3. Shape semantics are a weak spot

Measured case: a cube edited into a **pointed-roof house shape** in a Blender viewport.

- The model saw "a non-standard shape" and said it "has been edited"
- But it **kept calling it a cube**, and never attributed the mesh edits to the object

Honest caveat: from that camera angle the pointed roof genuinely was not prominent, so missing it is forgivable in that instance. But "never attributes mesh edits to the object" is a pattern that showed up beyond this one case.

### 4. Resolution is NOT the accuracy lever (counter-intuitive, but tested)

Same Blender window, same prompt, same model — only the resolution changed:

| Input size | Selected object | States the cube is unselected | Edit traces |
|---|---|---|---|
| 1942×1030 (native) | ✅ | not stated | only "a black triangle face" |
| 1295×687 (44.5% of the pixels) | ✅ | ✅ explicitly "unselected" | ✅ "a non-standard shape… has been edited" |

**The downscaled one scored better.** Conclusion: the model normalises its input, so at full-window scale the source resolution does not affect accuracy. (Behaviour when cropping is untested.)

### 5. One frame — no time, no causality

- ✅ It can answer "what is on screen right now"
- ❌ It cannot answer "did this dialog appear because I clicked X"

That has to be inferred from the **text** in the rolling memory — which is the main reason `screen_memory` exists.

### 6. Slow and expensive

Every call produces a large amount of reasoning tokens first (measured 788–6621 characters) before any answer. Each call takes seconds and is billed. **Continuous recording keeps spending**, which is why it defaults to off and enforces a 12-second minimum gap between calls.

### 7. The attachment store grows

Every vision call writes one content-addressed file into `${DSH_HOME}/attachments`, and **the plugin cannot prevent it** (an `llm.stream` image block requires a persisted attachment reference).

Observed: that directory has emptied itself before (28 files / 2.1 MB → 0), but **the trigger is unknown**. `vision_storage` reports only by default and never deletes on its own — those files are referenced by historical sessions, so deleting them breaks image rendering in past conversations.

### 8. Windows only

`scripts/capture.ps1` and `scripts/imageops.ps1` depend on PowerShell 5.1, `System.Drawing`, `PrintWindow` and `DwmGetWindowAttribute`. On any other platform it **fails loudly** rather than pretending to work.

---

## Install

### Option 1 — as a profile bundle (recommended)

```sh
dsh plugin --profile web add github:<your-username>/dsh-screen-reader
```

Restart the web profile and refresh the browser. The tools then appear in **every** session, with no preset switching.

### Option 2 — as an agent preset (verified working)

Put `lib/` and `scripts/` under `.agent-presets/<id>/plugin/` and add one row to `agent.cordis.yml`:

```yaml
- id: screen-reader
  name: './plugin/index.js'
  disabled: false
```

> Note: relative-path resolution differs between the two install modes; see the design notes in the Chinese README.

---

## Privacy

This plugin **captures your entire desktop**, including anything you would rather not send.

| Fact | Detail |
|---|---|
| Where the image goes | To the configured vision model route (the plugin never makes its own requests; it uses the DSH `llm` service) |
| Where the file lives | The plugin's own images live in `${DSH_HOME}/vision/`, capped at the newest 4 (`keep_` prefix is永久 pinned), and the live one is deleted when the plugin stops |
| Model attachments | One file per call into `${DSH_HOME}/attachments` (see boundary 7) |
| **Default state** | **Not recording.** Continuous capture starts only on an explicit `screen_watch({ on: true })` |
| Advice | Turn it on when needed and off afterwards; do not leave it running on a desktop holding sensitive material |

**Recording being off by default is a deliberate decision, not an oversight.** A plugin that continuously ships your desktop to a model API by default is the wrong default.

---

## Verification status: what is tested and what is not

| Capability | Status |
|---|---|
| Screen / window / region capture, DPI-native resolution | ✅ verified standalone (including failure paths and idempotence) |
| Local pixel diff | ✅ verified standalone (synthetic and real photographs) |
| The vision prompt and retry chain | ✅ measured across many runs |
| Attachment store reporting | ✅ measured |
| **`vision_selftest` scoring** | ❌ **never run** |
| **Bundle install** | ❌ **never run** (only the preset form has been mount-verified) |
| **A single accuracy number** | ❌ **does not exist** |

**There is no "92% accurate" figure here because accuracy has never been measured.** Every item under "Measured effects" is a concrete case, not a benchmark.

---

## Limitations and roadmap

**Planned for v0.2**

1. **Run `vision_selftest` and publish a baseline number** — the biggest gap today
2. Rewrite the tool definitions with `@deepseek-ai/dsh-tools`' `defineTool` to regain argument validation
3. Wire up a `Config` schema (tunables are file-head constants today)
4. Remove the prompt constants duplicated between `screen.js` and `toolbox.js`
5. A clear degradation path off Windows
6. Shape semantics: try a two-pass "locate the subject, then zoom into it", which is already proven to help selection accuracy

**Known design compromises**

- ~40 lines of duplicated prompt and error handling between `screen.js` and `toolbox.js` (see above; addressed in v0.2)
- Full-window accuracy is unaffected by resolution, but **whether cropping is** remains unverified
- Diff bounding boxes are 30–45 px larger than the real changes (tunable via `-Padding` / `-Dilate` / `-GridW`)

---

## Licence

MIT. See [LICENSE](LICENSE).

## Relationship to other plugins

This plugin does not compete on image Q&A — [`@liustack/modlens`](https://www.dsh.so/artifact/modlens/) does that better and more maturely. The differences are **continuity** and **local computation**:

- modlens is "show me this image"; this plugin also does "keep watching the screen and remember what just happened"
- modlens asks a model whether things differ; this plugin computes the difference locally and exactly
- modlens returns structured JSON evidence; this plugin returns prose backed by a written record of measurements

If all you need is the former, use modlens.
