# dsh-screen-reader

> Gives the agent eyes: **it looks at the screen itself, instead of waiting for you to take a
> screenshot.** Plus an **exact pixel diff** — "did it change, and where" is computed locally,
> and the model is only asked "what did it become".
>
> **Windows only.** Requires PowerShell 5.1 with `System.Drawing` and `PrintWindow`.

---

## ⚠️ Read this first: what the advantage actually is

**It does not make vision better.** Images reach the model through the model's own pipeline and are
squeezed onto the same normalised token grid. The plugin sees exactly as clearly as built-in vision
does — no more.

What it adds are two things a model **cannot get on its own**, and those two happen to decide whether
an agent can work by itself:

| Advantage | Why built-in vision cannot do it | What it means for automation |
|---|---|---|
| **1. The agent grows eyes** | A model can only read **files that already exist**. To let it see the screen you had to press `Win+Shift+S`, save, and drag the file in — every single time | The agent can **look during its own work**: check a setting after changing it, check output after running a script, look at what an interface actually shows when stuck. No human in the loop |
| **2. An exact "did it change"** | Ask a vision model "what changed between these two images" and it **fabricates** plausible differences — this is a thing it is demonstrably bad at | Deciding *whether* something changed goes from **probabilistic** to **certain**: computed locally, exact, free, with bounding boxes. The model is constrained to explain regions the diff already proved changed, so it has no room to invent |

In one sentence: **other plugins look at images for the model; this one gives the agent hands and eyes.**

That is its only reason to exist. If you are happy to screenshot manually and paste, it is worth
little to you — and a manual screenshot is often better, because you choose the crop.

### When you should **not** use it

| Your need | Better choice |
|---|---|
| I just want to ask about one image | The built-in `read_image`, or [`@liustack/modlens`](https://www.dsh.so/artifact/modlens/) (★3.9k, L5, Gold, structured JSON). **It is more mature at that job, and this plugin does not intend to compete there** |
| I need cross-platform | Windows-only, cannot help |
| I need to measure pixels precisely | Use a real measuring tool. This is a **describer**, not a gauge; measured size error reaches ±40% |
| I want "find what's wrong with my UI" for low-contrast details | That is its **danger zone** — see Boundaries |

---

## Contents

- [What it solves](#what-it-solves)
- [The two tools](#the-two-tools)
- [How images reach the model (this decides how you use it)](#how-images-reach-the-model-this-decides-how-you-use-it)
- [Measured effects](#measured-effects)
- [Boundaries: what it cannot do](#boundaries-what-it-cannot-do)
- [Install](#install)
- [Upgrading 0.2 to 0.3: breaking changes](#upgrading-02-to-03-breaking-changes)
- [Privacy](#privacy)
- [Design notes](#design-notes)
- [Verification status](#verification-status)
- [Known issues and plans](#known-issues-and-plans)
- [Reporting](#reporting)
- [License](#license)
- [Relation to other plugins](#relation-to-other-plugins)

---

## What it solves

Models have no eyes on your screen. So this happens:

- You say "something looks wrong in my interface" and the model can only work from your description
- The model says "click that button" — it has never seen that button
- You change a setting and the model does not know what it became
- You have an agent render an image or restyle a UI and **it cannot verify what it just produced**

The first three are "cannot see". The fourth is "cannot see **and** cannot self-verify" — and that is
the real bottleneck for automation.

The plugin gives the model two things:

1. **Sight**: capture the screen (whole desktop / one window / one region) and **hand the image
   itself to the current model**, with no second model transcribing it
2. **Verification**: locate changes between two images **exactly**, and let the model explain only
   "what it became"

---

## The two tools

### Screen

| Tool | Purpose |
|---|---|
| `see_screen` | Capture and **hand the image to the current model**. `window` limits it to one window; `region` does a normalized crop (**the only way to buy detail** — see the next section). No second model by default; `transcribe: true` is the compatibility path for text-only session models |

### Comparing two images

| Tool | Purpose |
|---|---|
| `see_diff` | Two images: **an exact local pixel diff locates the changed regions, then the model explains only those**. The model is never asked whether anything changed |

> **There is no "look at one image file" tool here.** There used to be `see_image`, but it was a
> worse duplicate of the built-in `read_image` (it added a model-to-model transcription hop).
> With built-in vision available, that job belongs to the built-in tool, so it was removed.

---

## How images reach the model (this decides how you use it)

The screen tool **does not hand the image to another model to transcribe; it returns the image
itself as a content block** for the current session model to look at. This path is verified.

On the **provider side** every image is force-normalised, and that decides all usage:

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

Normalisation actually happens in **two stages**, and the first one is measurable: the harness itself
caps the request at roughly **640,000 pixels** — a 1920×1080 screenshot went out as **1066×600**
(639,600 px) — and the provider then squeezes that onto its token grid. **Cropping works because a
small crop is passed through untouched by that first stage**, skipping the 0.555 linear downscale.

Three consequences are therefore **necessary, not coincidental**:

1. **Source resolution does not affect accuracy at full-window scale** — two different resolutions
   land on the *same* grid
2. **Cropping is the only way to buy detail** — measured at roughly **2×** the effective detail density
3. **Raising capture resolution buys no accuracy** — a larger source is simply compressed harder

**This part is measured, not derived.** Same sidebar region, same prompt:

| Input | Session title as read |
|---|---|
| Full screen 1920×1080 | 杀**戳**尖塔模组制作 ✗ |
| Crop 346×346 | 杀**戮**尖塔模组制作 ✓ |

Ground truth came from the session index under `${DSH_HOME}/storages`. At full screen, 4 of 5 titles
were character-exact and **1 was wrong**; after cropping, **none were wrong**. The full-screen failure
mode was exactly **visually similar characters** (戮/戳 share the same right-hand radical) — precisely
what a 0.49 sampling rate predicts.

**So the intended usage is: pin the application with `window`, then zoom with `region`.**

---

## Measured effects

Everything below was measured on real runs, not designed.

### Vision

| Item | Result |
|---|---|
| Reading bar-chart values (synthetic, 4 bars) | **4/4 exact** (120 / 60 / 180 / 90), colours and ordering correct |
| Reading a Blender Outliner list | **4/4** (`Camera / Cube / Light / 球体`), matching headless-Blender ground truth |
| Reading a Chinese path from a title bar | Character-exact |
| Judging which object is selected | **0/3 before a prompt fix, 2/2 after** |
| `LOCATION` structured output | **2/2 emitted as required**, parseable into a `region` |
| Reading sidebar session titles (full screen 1920×1080) | 4 of 5 titles character-exact, **1 character wrong** (`戮` → `戳`) |
| Reading the same region (crop 346×346) | **5/5 character-exact**, and spurious spaces disappeared |

### Local pixel diff (the most reliable part)

| Item | Result |
|---|---|
| Real photo (1225×1254 JPEG) with 2 programmatic edits | **Exactly 2 regions detected, zero false positives** |
| Positional accuracy | Bounding boxes ~30–45 px larger than the true edits (= padding 10 + grid quantisation + dilation 1) |
| An image compared with itself | 0 changed pixels, correctly reported as "no change" |
| Synthetic calibration image (4 known edits) | All 4 regions matched; two of them were merged into one region by dilation (known trade-off) |

### Cost

**Images are cheap**: the provider normalises every request image to **≤384 vision tokens** regardless
of source size. The earlier claim of "about 1000-1500 tokens per look" **was wrong**.

**What is expensive is having a model turn an image into text.** On the transcription compatibility
path, that model first spends a large reasoning budget (measured 788–6621 chars) before emitting any
prose. **That is why the default path calls no second model** — the image goes straight to the current
model.

---

## Boundaries: what it cannot do

This is the most important section in this document.

### 1. It is a describer, not a gauge

Measured: a **30 px** tall colour band was read as "40–45 px" — **about 40% error**.

- ✅ Reliable: which is taller, which is greyed out, roughly upper-left or lower-right
- ❌ Unreliable: is the gap 8 px, is this spacing 16 or 12

### 2. Low-contrast differences are the danger zone

Reverse validation works (grey vs saturated blue "disabled button" is easy), but the genuinely hard
cases — two similar greys, a 1 px offset, a faint colour shift — are exactly where it misses, or
**worse: confidently invents one**. And "tell me what's wrong with my UI" needs precisely those.

### 3. Shape semantics are a weak spot

Measured case: a cube edited into a "pointed little house" in a Blender viewport.

- The model saw "a non-standard shape" and said "this object has been edited"
- But it **kept calling it a cube** and never **attributed** the mesh edit to the object

Honest caveat: at that camera angle the point was genuinely subtle, so missing it is **partly
forgivable**. But the pattern — not attributing a mesh edit to the object — appears beyond this one case.

### 4. Resolution is NOT the accuracy lever, but cropping IS

Same Blender window, same prompt, same model — only the resolution changed:

| Input size | Selected object | Says the cube is unselected | Edit evidence |
|---|---|---|---|
| 1942×1030 (native) | ✅ | not stated | only "black triangular face" |
| 1295×687 (44.5% fewer pixels) | ✅ | ✅ explicitly "not selected" | ✅ "non-standard shape… has been edited" |

**The downscaled one scored better.** Conclusion: the provider normalises its input, so at
full-window scale the source resolution does not affect accuracy. The mechanism is in the previous
section, and the same mechanism explains why **cropping works** — measured at roughly 2× the
effective detail density.

### 5. One frame only — no time, no causality

- ✅ It can answer: "what is on the screen right now"
- ❌ It cannot answer: "did this dialog appear because I clicked X"

Rolling screen memory (`screen_memory` / `screen_watch`) existed to cover this and was **removed in
0.3**: no real use case ever demonstrated its value, while every recorded frame wrote a file into the
attachment store. So today it genuinely **sees only the present**.

### 6. The attachment store grows

Every vision call writes a content-addressed file into `${DSH_HOME}/attachments`, and **the plugin
cannot prevent it** (image blocks in `llm.stream` need a persisted attachment reference).

Observed: **it keeps growing** — after one long session it reached **112 files / 19.58 MB**. It was
also once observed emptying itself (28 files / 2.1 MB → 0), and the trigger **remains unidentified**.

0.2.1 had a `vision_storage` tool to report and optionally prune that directory; **0.3 removed it**
(it was a diagnostic, not a capability). Look in that directory yourself if you need to.

### 7. Windows only

`scripts/capture.ps1` and `scripts/imageops.ps1` depend on PowerShell 5.1, `System.Drawing`,
`PrintWindow` and `DwmGetWindowAttribute`. On other platforms they **fail honestly** rather than
pretending to succeed.

---

## Install

### Option 1 — as a profile bundle (recommended, **installed on a real instance and composition-verified**)

```bash
dsh plugin --profile <profile-name> add <package-or-local-path>
# for a local directory:
#   dsh plugin --profile web add C:\path\to\dsh-screen-reader
```

`dsh plugin` forwards its arguments to pnpm and then **automatically appends every dependency that
declares `dsh.bundle.patch` to the `dsh.profile.bundles` layer stack** — this package declares it, so
no manual configuration is needed.

**DSH must be restarted** before the row joins the running composition: the bundle layer stack is
composed at process start, so a running process never notices a newly installed package.

Check that it landed, without restarting:

```bash
dsh --profile <profile-name> --dump-config
# the output should contain:
#   # == dsh-screen-reader
#   - id: screen-reader
#     name: dsh-screen-reader
```

Then restart DSH and ask any session "which tools do you have related to screens and images?" — it
should list **two**: `see_screen` and `see_diff`.

**The row is a `link:` to the package directory** (that is what pnpm does for local directory
dependencies), so **do not delete or move that directory** — DSH would fail to find it at startup. To
uninstall: `dsh plugin --profile <profile-name> remove dsh-screen-reader`.

> ⚠️ **The 0.2.0 bundle was broken; 0.2.1 fixes it.** Reviewing the code, I found that `lib/screen.js`
> and `lib/toolbox.js` located their PowerShell helpers with `new URL('capture.ps1', import.meta.url)`
> — but in the package the JS lives in `lib/` while the helpers live in `scripts/`, so they looked for
> a `lib/capture.ps1` that does not exist. Any bundle install failed on the first capture with
> `The argument '.../lib/capture.ps1' to the -File parameter does not exist.`
> The runtime now handles both layouts (the same source is correct as a preset and as a package), and
> that check is now an assertion in the generator (`tools/build-lib.mjs`). If you installed 0.2.0,
> please upgrade.
> **To be explicit:** what is verified is the install and the composed tree. The tool list inside a
> restarted session is still unconfirmed — that needs a process restart, which I did not perform
> mid-session.

### Option 2 — as an agent preset (**verified working**)

Put `lib/` and `scripts/` into a preset directory, wire up `agent.cordis.yml`, and open a session on
that preset. See the DSH docs for preset syntax and relative-path resolution.

### Self-check after installing

> Which tools do you have related to screens and images?

You should see **two**: `see_screen`, `see_diff`.

- **They appear** → installed. Then actually call `see_screen` once to confirm it really returns an image
- **They do not** → the plugin was not loaded. Try the other install method, or file an issue with your
  DSH version, profile name and the full error

---

## Upgrading 0.2 to 0.3: breaking changes

**0.3 is a large reduction. The tool count goes from 8 to 2.**

| Tool in 0.2 | In 0.3 | Why |
|---|---|---|
| `see_screen` | **kept** | Gives the agent eyes. This is the core |
| `see_diff` | **kept** | Exact local diff; a model cannot do it |
| `see_image` | **removed** | A worse duplicate of the built-in `read_image` |
| `screen_watch` | **removed** | No real use case; wrote one attachment file per frame |
| `screen_memory` | **removed** | Same (the time dimension is abandoned) |
| `vision_routes` | **removed** | Diagnostic |
| `vision_selftest` | **removed** | Never ran; covered only the diff chain, never `see_screen` |
| `vision_storage` | **removed** | Diagnostic |

**What to do when upgrading:**

1. **If a prompt or script of yours names a removed tool, change it.** Calling a removed tool returns
   "unknown tool"; it does not silently degrade
2. **`see_screen`'s plugin declaration changed**: `inject` went from `['tools','timer']` to
   `['tools']`. If you install as a preset and wrote your own `agent.cordis.yml`, you do not need to
   change anything — `inject` lives in the plugin source, not in configuration
3. **Preset rows need no change**: the two plugin rows are still `./plugin/screen.js` and
   `./plugin/toolbox.js`; they simply register fewer tools
4. Old versions do not auto-upgrade; the plugin is a local/package install with no update channel

**Unchanged:** the parameters and return values of the two kept tools, and how `cordis.patch.yml`
inserts the row.

---

## Privacy

This section matters, because screen contents are the most sensitive thing here.

1. **Nothing happens unless something captures.** 0.3 removed continuous recording, so there is no
   background capture at all. A screenshot is taken only when you (or the agent) explicitly call
   `see_screen`
2. **The screenshot goes only to the current session's model.** It travels the same channel as images
   you paste yourself, under the same data policy. The plugin sends nothing to any third party
3. **On disk the plugin keeps one image**: a fixed path overwritten in place
   (`${DSH_HOME}/vision/screen.png`), deleted when the plugin stops
4. **But the attachment store is a separate matter**: every vision call adds a content-addressed file
   under `${DSH_HOME}/attachments` and **nothing cleans it up** (observed at 112 files / 19.58 MB in
   one session). See boundary 6
5. **`see_diff` never captures the screen**: it only reads the two image files you point it at
6. **Suggestion**: call it when needed; there is no longer any reason to leave it "on", because it no
   longer captures anything by itself

---

## Design notes

### Why the plugin modules have zero dependencies

The loader resolves relative specifiers against the preset directory and bare package names against
the harness install — a local preset cannot reach `@deepseek-ai/dsh-tools`. So the plugin deliberately
depends on nothing: instead of `defineTool(...)` it constructs the runtime shape that helper produces,
and writes raw JSON Schema (which is why every schema spells out `required`). It imports only
`node:fs` and `node:url`.

**Cost: no automatic parameter validation from `defineTool`**, so every `execute` does its own type
coercion.

### Why half the tools were deleted

The only criterion was: **can the model already do this itself?**

- It can (look at an image, read text in an image) → delete, use the built-in capability
- It cannot (see the screen, decide exactly which pixels changed) → keep

By that criterion `see_image` was duplication, the three diagnostics were not capabilities, and
continuous recording had no demonstrated value against a certain cost (unbounded attachment growth).
The plugin went from 8 tools and ~78 KB of source to 2 tools and ~54 KB.

### Why the diff is computed locally

Vision models are poor at fine-grained change spotting and will invent "plausible" differences. A
pixel diff is exact, free, and yields bounding boxes. So the split is: **compute the diff locally,
let the model only explain it.**

### Why `see_screen` returns the image instead of text

It used to hand the capture to a second model to transcribe. That path had three problems: an extra
layer of transcription error, subjection to that model's reasoning budget (which routinely consumed
the entire budget and left the prose empty), and a second billed call. Now the image is returned as a
content block for the current model to look at. `transcribe: true` remains for text-only session models.

### Why the prompt puts "subject" first

Measured: if the prompt asks for verbatim text first, the model transcribes text and ignores the
picture. After making "answer the subject first, text last" an ordering requirement, judging the
selected object went from 0/3 to 2/2.

---

## Verification status

| Item | Status |
|---|---|
| Screen / window / region capture, DPI-native resolution | ✅ verified standalone (including failure paths and idempotence) |
| Local pixel diff | ✅ verified standalone (synthetic + real photo) |
| Vision prompt | ✅ measured over several rounds |
| **Tools hand the image to the model** (image content block) | ✅ measured (a probe confirmed real delivery) |
| `see_screen`'s transcription compatibility path | ✅ measured over several rounds (see Cost) |
| **Bundle install** | ✅ **verified end to end** (0.3.0): `dsh plugin --profile web add <local dir>` succeeded; `--dump-config` shows `- id: screen-reader` in the composed tree; after a restart, querying `Tool.listTools` on the running process returns **`see_screen` and `see_diff`** — and they are visible in a session that did **not** select the screen preset, proving the row is host-plane and reaches every conversation. Both backends of the installed artifact were also exercised for real (capture 576×54; diff 4 regions with the input images surviving) |
| **A single accuracy number** | ⚠️ only one **tiny-sample** character accuracy (below); **not a benchmark** |
| Practical value of `screen_watch` / `screen_memory` | ❌ **never demonstrated by any real use case** (the direct reason 0.3 removed them) |
| `vision_selftest` scoring | ❌ never ran (removed) |

**There is still no "92% accurate" benchmark figure here.** Every item under "Measured effects" is a
concrete case, not a benchmark.

The closest thing to a number: in one comparison over **5 session titles / 50 Chinese characters**,
full-screen 1920×1080 got **1 character wrong**, and a 346×346 crop got **0 wrong**. That sample is
far too small to call an accuracy rate — all it shows is that the full-screen failure mode is
**visually similar characters**, and that cropping fixes it.

---

## Known issues and plans

**What 0.3.0 changed:**

- **`see_diff` deleted your input images (data loss; fixed)**: `imageops.ps1`'s retention rule
  deleted the N oldest files in the output directory **no matter who wrote them**. So when the two
  images you wanted to compare happened to live in the same folder as the crop files, retention ran
  after writing, protected this run's crops, and then ate your `a.png` / `b.png`. Silent data loss of
  exactly the thing that cannot be regenerated. Retention now deletes **only files this tool itself
  produced** (`diff*_A.png` / `diff*_B.png`), and every call site additionally protects the explicit
  inputs it was handed. Verified: inputs survive, and the crops still stop growing
- **Tool count 8 → 2** (criterion in Design notes). Removed `see_image`, `screen_watch`,
  `screen_memory`, `vision_routes`, `vision_selftest`, `vision_storage`
- Removed with them: the change fingerprint, rate-limit gate, rolling buffer, the `timer` dependency,
  concurrency mutex — and a branch in `see_screen` that could never be reached (it always called
  `observe` with `force=true`, so those checks were dead code)
- `see_screen` source 50.3 KB → 35.1 KB; `toolbox` 27.5 KB → 19.1 KB
- Breaking-change list in the previous section

**What 0.2.1 fixed:**

- **The published ps1 paths were broken (0.2.0's bundle could never work)**: now resolved at runtime
  for both layouts (the same source is correct as a preset and as a package), with the generator
  `tools/build-lib.mjs` committed to the repo and asserting it
- **`capture.ps1 -Out` with a bare name polluted the current directory**: bare names now resolve into
  `${DSH_HOME}/vision/` and get a `.png` extension; absolute paths unchanged
- **Documentation correction**: crop detail density revised down from a derived "2.7×" to a
  **measured ~2×**

**Plans:**

1. **Produce a real accuracy benchmark** — the biggest remaining gap. It was going to be
   `vision_selftest`, but that covered only the diff chain and never `see_screen`, which is where a
   number is most needed. So it was removed and the benchmark needs redesigning
2. Rewrite the tool definitions with `@deepseek-ai/dsh-tools`' `defineTool` to get parameter validation back
3. Wire up the `Config` schema (tunables are file-header constants today)
4. Trim the now-unreferenced modes in `scripts/imageops.ps1` (`calib-draw` / `calib-bad` / `storage` /
   `prune`), which existed for removed tools
5. Shape semantics: try a two-pass "locate the subject, then zoom into it", already proven to help
   selection accuracy

**Known design trade-offs:**

- About 40 lines of duplicated vision-routing and error handling between `lib/screen.js` and
  `lib/toolbox.js`. The reason is in the file headers: the loader caches modules by URL, and a
  relative import would tie the two plugins' lifetimes together
- Diff bounding boxes are 30–45 px larger than the true change (tunable via `-Padding` / `-Dilate` /
  `-GridW`)
- The time dimension (rolling screen memory) has been abandoned. If a real use case appears, it can be
  recovered from git history (`git show 98306ac5:lib/screen.js`)

---

## Reporting

This plugin is **experimental** and admits to plenty it cannot do. The feedback I want most is
"**here is where it got it wrong for you**", not praise.

Please include:

1. **Install method** (bundle / preset) and `dsh --version`
2. The tool you called and its full arguments
3. The complete return value or error (not just "it doesn't work")
4. If an image is involved: **attach that image.** Without it I cannot tell whether the fault is the
   plugin or the model

---

## License

MIT. See `LICENSE`.

---

## Relation to other plugins

| Plugin | Focus | Relation |
|---|---|---|
| Built-in `read_image` | Read one image file | `see_image` was a duplicate of it; removed in 0.3 |
| [`@liustack/modlens`](https://www.dsh.so/artifact/modlens/) | Image Q&A with structured JSON (★3.9k, L5, Gold) | **More mature at "ask about one image"**. This plugin does not intend to compete there |
| This plugin | **Eyes for the agent + exact pixel-change detection** | Its distinct value is "the agent looks by itself" and "an exact local diff", not image Q&A |
