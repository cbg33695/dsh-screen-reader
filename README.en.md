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

## The seven tools

**Screen**

| Tool | Purpose |
|---|---|
| `see_screen` | One immediate look. Supports `window` (a process name or title substring) and `region` (normalized crop). Returns a parsed `suggestedRegion` you can pass straight back for a closer second look |
| `screen_watch` | Start/stop continuous change-driven recording. **Off by default**; requires an explicit `{ on: true }` |
| `screen_memory` | Read the rolling short-term visual memory |
| `vision_routes` | Report which model routes declare image input support |

**Comparing two images**

| Tool | Purpose |
|---|---|
| `see_diff` | Two images: **an exact local pixel diff locates the changed regions, then the model explains only those** |
| `vision_selftest` | Self-calibration: draw an image whose every fact is known by construction, apply known edits, have the model describe them, score against the known truth |
| `vision_storage` | Report (and optionally prune) the DSH attachment store |

> **There is no "look at one image file" tool here.** There used to be `see_image`, but it was
> a duplicate of the built-in `read_image` — and the worse of the two, since it added a
> model-to-model transcription hop. With built-in vision available, that job belongs to the
> built-in tool, so it was removed.

---

## How images reach the model (this decides how the plugin is used)

From 0.2 the screen tools **no longer hand the image to a second model for transcription — they return the image itself as a content block**, so the model of the current session looks at it directly. That path is verified (see the status table).

Images are also force-normalised on the **provider** side, and that decides everything about usage:

```
14px patch grid · 3:1 downsample per axis · 384 tokens per image, capped
```

| What you captured | What the request actually carried | Screen pixel → request pixel |
|---|---|---|
| Full window 1942×1030 | ≈ 950×504 | 0.49 |
| The same, downscaled to 1295×687 | ≈ 950×504 | 0.49 |
| A crop of 675×387 | ≈ 879×504 | 1.30 |
| **A crop of 346×346 (measured)** | **346×346, untouched** | **1.00** |

(The 675×387 row is *derived from source constants*, not measured. The 346×346 row is measured.)

Normalisation actually happens in **two stages**, and the first one is measurable: the harness itself caps the request at roughly **640,000 pixels** — a 1920×1080 screenshot went out as **1066×600** (639,600 px) — and the provider then squeezes that onto its token grid. **Cropping works because a small crop is passed through untouched by that first stage**, skipping the 0.555 linear downscale.

Three consequences are therefore **necessary, not coincidental**:

1. **Source resolution does not affect accuracy at full-window scale** — two different resolutions land on the *same* grid. This is the mechanical reason my ablation found the downscaled one slightly better
2. **Cropping is the only way to buy detail** — measured at roughly **2×** the effective detail density (1.00 vs 0.49). The earlier "2.7×" was a pure derivation depending on how the provider treats small images; I never measured it, so **it has been revised down to the measured value**
3. **Raising capture resolution buys no accuracy** — a larger source is simply compressed harder

**This part is measured, not derived.** Same sidebar region, same prompt:

| Input | Session title as read |
|---|---|
| Full screen 1920×1080 | 杀**戳**尖塔模组制作 ✗ |
| Crop 346×346 | 杀**戮**尖塔模组制作 ✓ |

Ground truth came from the session index under `${DSH_HOME}/storages`. At full screen, 4 of 5 titles were character-exact and **1 was wrong**; after cropping, **none were wrong**. The full-screen failure mode was exactly **visually similar characters** (戮/戳 share the same right-hand radical) — precisely what a 0.49 sampling rate predicts.

**So the intended usage is: pin the application with `window`, then zoom with `region`.**

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

### 4. Resolution is NOT the accuracy lever, but cropping IS (counter-intuitive, but tested)

Same Blender window, same prompt, same model — only the resolution changed:

| Input size | Selected object | States the cube is unselected | Edit traces |
|---|---|---|---|
| 1942×1030 (native) | ✅ | not stated | only "a black triangle face" |
| 1295×687 (44.5% of the pixels) | ✅ | ✅ explicitly "unselected" | ✅ "a non-standard shape… has been edited" |

**The downscaled one scored better.** Conclusion: the model normalises its input, so at full-window scale the source resolution does not affect accuracy. (Whether cropping helps was untested then — it is **verified once now**: cropping turned a wrong character into the right one.)

### 5. One frame — no time, no causality

- ✅ It can answer "what is on screen right now"
- ❌ It cannot answer "did this dialog appear because I clicked X"

That has to be inferred from the **text** in the rolling memory — which is the main reason `screen_memory` exists.

### 6. Cost (corrected — the earlier figure was wrong)

**Images are cheap.** The provider normalises every request image to **≤384 vision tokens** regardless of source size. My earlier claim of "about 1000–1500 tokens per look" **was wrong**.

**What is expensive is the model's own reasoning.** On the transcription compatibility path that model spends a large number of reasoning tokens first (measured 788–6621 characters). The **default path now calls no second model at all** — the image goes straight to the current model.

**Continuous recording is now free**: `screen_watch` capturing a frame **calls no model**; you pay only when `screen_memory` hands frames back.
### 7. The attachment store grows

Every vision call writes one content-addressed file into `${DSH_HOME}/attachments`, and **the plugin cannot prevent it** (an `llm.stream` image block requires a persisted attachment reference).

Observed: that directory has emptied itself before (28 files / 2.1 MB → 0), but **the trigger is unknown**. `vision_storage` reports only by default and never deletes on its own — those files are referenced by historical sessions, so deleting them breaks image rendering in past conversations.

### 8. Windows only

`scripts/capture.ps1` and `scripts/imageops.ps1` depend on PowerShell 5.1, `System.Drawing`, `PrintWindow` and `DwmGetWindowAttribute`. On any other platform it **fails loudly** rather than pretending to work.

---

## Install

> **Two methods, and only the second one has actually been verified.** See the verification table in the Chinese README.

### Option 1 — as a profile bundle (recommended, **never installed on a real instance**)

```sh
dsh plugin --profile web add github:cbg33695/dsh-screen-reader
```

Restart the web profile and refresh the browser. The tools then appear in **every** session, with no preset switching.

This is the ecosystem's standard shape and the reason it is listed first: one command, no preset switching, lowest friction for someone trying it out. **But I have never installed it on a real instance** (see the verification table). If your instance refuses it, use Option 2 and paste the full error into an issue.

> ⚠️ **The 0.2.0 bundle was broken; 0.2.1 fixes it.** Reviewing the code, I found that `lib/screen.js` located its PowerShell helper with `new URL('capture.ps1', import.meta.url)` — but in the package the JS lives in `lib/` while the helpers live in `scripts/`, so it looked for a `lib/capture.ps1` that does not exist. Any bundle install failed on the first capture with
> `The argument '.../lib/capture.ps1' to the -File parameter does not exist.`
> The runtime now handles both layouts (the same source is correct as a preset and as a package), and that check is now an assertion in the generator, so a regression fails the build instead of shipping. If you installed 0.2.0, please upgrade.
> **To be explicit:** what I verified is "the path resolves to a real file and a capture succeeds through it". I still have **not** completed a real bundle install on a live instance.

### Option 2 — as an agent preset (**verified working**)

Put `lib/` and `scripts/` under `.agent-presets/<id>/plugin/` and add one row to `agent.cordis.yml`:

```yaml
- id: screen-reader
  name: './plugin/index.js'
  disabled: false
```

> Note: relative-path resolution differs between the two install modes; see the design notes in the Chinese README.

### Post-install self-check (10 seconds)

Open a new session and ask:

> Which tools do you have for the screen and for images?

You should see seven: `see_screen`, `screen_watch`, `screen_memory`, `vision_routes`, `see_diff`, `vision_selftest`, `vision_storage`.

- **They appear** → installed. Run `vision_routes` next to confirm this machine has a model route that declares image input.
- **They do not** → the bundle was not loaded. Use Option 2, or file an issue with your DSH version, profile name and the full error.

> ⚠️ `vision_selftest` is the only self-check that **spends money** — it really calls the model. Skip it if you would rather not.

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
| **Bundle install** | ⚠️ never installed on a real instance. But **0.2.1 fixed a path bug that made every bundle install fail** (see Install), and I did verify "package imports + the resolved .ps1 really exists + a capture succeeds through it" |
| **A single accuracy number** | ⚠️ only one **tiny-sample** character accuracy (below); **not a benchmark** |

**There is still no "92% accurate" benchmark figure here.** Every item under "Measured effects" is a concrete case, not a benchmark.

The closest thing to a number: in one comparison over **5 session titles / 50 Chinese characters**, full-screen 1920×1080 got **1 character wrong**, and a 346×346 crop got **0 wrong**. That sample is far too small to call an accuracy rate — all it shows is that the full-screen failure mode is **visually similar characters**, and that cropping fixes it.

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
- Whether cropping really improves accuracy — **confirmed once** (it fixed a visually-similar-character error), but a single sample cannot be generalised
- Diff bounding boxes are 30–45 px larger than the real changes (tunable via `-Padding` / `-Dilate` / `-GridW`)

---

## Reporting problems

This plugin is **experimental** and already admits to plenty it cannot do. The feedback I want most is "**here is where it was wrong for you**", not praise.

Please include:

1. **Install method** (bundle / preset) and `dsh --version`
2. **What you pointed it at** (which application, what was on screen)
3. **What it got wrong, and what the right answer was** — the most valuable item. If that screen has **programmatic ground truth** (a file's contents, Blender's scene objects, a command's output), paste it too; that is how the Blender test got hard numbers
4. **A screenshot** for recognition errors where possible (redact first)
5. The **full error** for install failures

Especially wanted:

| Question | Why |
|---|---|
| **On what kind of screen does it invent things?** | Far more serious than merely getting something wrong — invented content leads people to wrong decisions, and I only know it *can* happen (low-contrast areas), not where the boundary is |
| **How tight does a crop have to be?** | I verified that full-window resolution does not affect accuracy, but **the cropping boundary is completely unverified**. It decides how the tool should be used |
| **What continuous recording really costs** | I never measured an hour of recording. Anyone leaving it on needs that number |

If you run `vision_selftest`, **posting the score is the single biggest contribution** — it is the one hard number this project does not have.

---

## Licence

MIT. See [LICENSE](LICENSE).

## Relationship to other plugins

This plugin does not compete on image Q&A — [`@liustack/modlens`](https://www.dsh.so/artifact/modlens/) does that better and more maturely. The differences are **continuity** and **local computation**:

- modlens is "show me this image"; this plugin also does "keep watching the screen and remember what just happened"
- modlens asks a model whether things differ; this plugin computes the difference locally and exactly
- modlens returns structured JSON evidence; this plugin returns prose backed by a written record of measurements

If all you need is the former, use modlens.
