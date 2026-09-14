# Agent Preset: `screen-control`

An independent preset whose agent operates a real desktop. The plugin behind it
provides only low-level capability: it is named by this preset's composition and
therefore exists only for an agent composed from this preset — it does not run on
its own and is not exposed anywhere else.

## Storage

Every capture and intermediate image lives under:

```
C:\Users\11196\.dsh\.agent-presets\screen-control\screenshots\
```

Named `r{round}_{stage}_{timestamp}.png`, where `stage` is one of
`capture`, `grid`, `compressed`, `verify`, `verify_view`. The plugin writes
nowhere else — not the desktop, not Temp, not the user profile — and every round
ends by deleting its own files and proving the directory holds no image.

## Verified end to end, and what that run exposed

A full live task was driven through this preset: focus a browser, load a page,
open a video, confirm playback, close the browser. It succeeded, and it also
surfaced four defects that unit testing had not caught, because each one only
appears when the tools are used in anger.

**Playback was confirmed by measurement, not by looking.** Two raw captures of
the player region four seconds apart differed by 4.31 mean luma while a static
part of the same page differed by 0.007 — the change is localised to the player,
so the video is playing. One screenshot cannot answer that question: a paused
video and a playing one look identical in a single frame.

Defects found and fixed:

- **Keyboard actions demanded a coordinate.** `screen_do` required a fresh
  coordinate verification before *any* action, including `key_press`. A
  keystroke goes to whatever holds focus, so there is no coordinate to be wrong
  about — and the first step of most tasks, focusing a window, was therefore
  impossible. Keyboard actions now require an open round but no verification;
  pointer actions still require both.
- **`cleanup_round` wiped the whole directory and ignored `round_id`.** The
  spec named `round_id` as a parameter; the implementation did not accept it and
  deleted every image in the directory regardless of round. Capturing twice to
  compare two moments destroyed the first frame. Cleanup is now scoped: the
  current round by default, one earlier round by `round_id`, and `all_rounds`
  for the end-of-task sweep that must also clear an image an interrupted run
  left untracked.
- **A superseded round's file list was discarded.** `round_id` could therefore
  only address rounds that had already been cleaned — that is, it could not
  address anything still needed. The list is now recorded when a round is
  superseded.
- **Windows reported no owning process.** `foregroundWindow()` returned a title
  and class, so `dsh web [ConsoleWindowClass]` gave no warning that it was a
  console, and a URL was typed into it. Every window report now names the
  executable and pid, which is what makes "which window am I about to drive"
  answerable before input is delivered rather than after.

One limitation is documented rather than fixed: `screen_probe` separates
elements by brightness against a dark background, so it measures icon rows
precisely and finds nothing useful on a bright web page, where a whole card
reads as one blob. For page content, `screen_zoom` and the grid labels are the
right tools.

## How a frame reaches the model

An image can be attached to a tool result in two ways and only one of them is
correct:

- **an image content block** — `{ type: 'image', attachment: {...} }` — which the
  request adapter resolves against the attachment store and sends as a real
  image part. The bytes live in the store keyed by digest; only a small
  reference travels.
- **a text block holding a `data:image/png;base64,...` URL** — which is just
  text. Half a megabyte of it, at roughly 1.5 characters per token, is hundreds
  of thousands of tokens for a single frame.

The plugin prefers the image block, and the frame's text says which form was
used rather than leaving the reader to infer it. The text form survives only as
an explicitly-labelled fallback for a deployment with no attachment store, so a
missing store produces a message that says so instead of a silent wall of
base64.

Verified against the real request serializer: `execute` returns the text,
`finalizeContent` contributes the image block, the store is called once per
frame, and a second finalize for the same call yields nothing. The `name` on the
attachment is a basename, because that field is documented as a display name and
is never interpreted as a path.

Two mistakes were made and caught here, both worth recording because neither was
visible without measuring:

- `finalizeContent` was first written **inside** `output`. `defineTool` reads it
  from the tool definition, so a nested one is silently dropped and every frame
  falls back to text with no error anywhere.
- the attachment service was accepted on truthiness alone, so an object lacking
  `saveImage` was reported as "the store refused this frame" — a materially
  different and more confusing claim than "there is no store here". The shape is
  now checked.

## One open round PER SESSION

A preset is a standing mount: every session that names it joins the same
composition, so the plugin instance is shared. Its round state therefore cannot
be a single "current round" pointer — and it was one. `sessionId` was recorded
on each round but never used to scope anything.

The consequence was not cosmetic. With two sessions on this preset, whichever
opened a round last owned the pointer, so the other session's `screen_compress`,
`screen_mark_verify`, `screen_do` and `screen_cleanup_round` all operated on a
stranger's frame. Two failures followed directly:

- the verification token is a **click licence**, and it became satisfiable by
  another session's verification;
- a cleanup aimed at "my current round" **deleted the other session's files**.

Round state is now keyed by session. `require()` and `requireVerified()` resolve
the caller's own round, cleanup defaults to the caller's own round, and the
whole-directory sweep still covers every session. Verified with two concurrent
sessions: distinct round numbers, each `require` returning its own, one
session's token refusing the other, and one session's cleanup leaving the
other's files intact.

## The ten capabilities

| Capability | Tool | What it guarantees |
| --- | --- | --- |
| `capture_fullscreen()` | `screen_capture` | The composited frame from the screen device context via GDI `BitBlt` — what PrtSc captures. Never a window handle, never a re-render. Returns physical geometry, DPI factor, and the image path. It is also the **only confirmation frame**: taking it clears the unconfirmed-input ledger and names the input it covered. |
| `overlay_grid(image, spacing)` | `screen_overlay_grid` | Evenly spaced grid whose every label is a **real desktop coordinate**. Spacing adapts: 50 px logical below a 1080 short edge, otherwise 100 px. |
| `zoom(region, factor)` | `screen_zoom` | Magnifies a region so small elements can be looked at. One desktop pixel becomes `factor` image pixels. The frame narrows to that rectangle while grid, mapping, marker and click all keep using real desktop coordinates. **It is a magnifying glass, not a view of the screen**: it never confirms the screen's state and never stands in for the post-input capture. |
| `probe(band, axis)` | `screen_probe` | **Measures the elements in a strip from the native pixels** and returns each one's exact desktop centre, size and colour composition. This is the answer to "which icon is it" for a taskbar, toolbar, ribbon or tab strip — measured, not read off an image. |
| `compress(image, max_edge)` | `screen_compress` | Long edge → 1280 when the source exceeds 1920, otherwise 1600. **Identity when the source is already within the cap**, and never applied to a magnified frame by default — either would shrink a zoom straight back to full-screen scale. |
| `ask_ai(compressed, prompt)` | `screen_ask_ai` | Records the visual analysis and the target's image pixel `(gx, gy)`. This preset uses the agent's own vision: no second model is called and no coordinate is invented. |
| `map_to_screen(gx, gy, meta)` | `screen_map_to_screen` | `screen = image / scale + origin`, where `scale = compression x zoom` and the region origin's sign is preserved for multi-display desktops. Flags a DISCREPANCY when it disagrees with the coordinate `screen_ask_ai` recorded. |
| `mark_and_verify(x, y)` | `screen_mark_verify` | Draws a red crosshair at the coordinate a click would use, measures where it landed, and refuses when the marker was clipped or drifted. **Cannot be skipped: `screen_do` refuses without it.** |
| `simulate_input(action)` | `screen_do` | click / double_click / right_click / drag / scroll / key_type / key_press, with 150-300 ms settling. Pointer actions refuse without a fresh verification, re-fingerprint the screen under the target, read the cursor position back before pressing, and report whether the interface reacted *at that point*; keyboard actions go to the focused window, need no coordinate, and report which executable owns it. Every delivered input is recorded as unconfirmed, and only a later full-screen capture clears it. | |
| `cleanup_round(round_id)` | `screen_cleanup_round` | Deletes a round's images, re-reads the directory, forces a second removal, and fails if any image survives. Scoped: the current round by default, `round_id` for an earlier one, `all_rounds` for the whole-directory sweep. Also **refuses to close a round whose delivered input was never covered by a full-screen capture**, unless `skip_confirmation` says the target is being abandoned. |

## Identification is a safety property, not a convenience

Two real runs of this preset clicked the taskbar and opened nothing, and both
failures had the same shape: **the element was never identified, and every
downstream check confirmed the wrong place anyway.**

- Run 1 clicked empty taskbar space. At 0.5 compression a taskbar icon is about
  7 px across; two similar icons are genuinely indistinguishable, and the
  coordinate read off that view was hundreds of pixels from any icon.
- Run 2 clicked with a crosshair that verified at 0.13 px offset. The arithmetic
  was perfect and the target was wrong: it aimed at x≈1441, and Edge is at
  **x≈552**.

Marker verification, drift checks and cursor read-back all prove *the click went
where it was told*. None of them can prove *it was told the right place*. So
identification gets its own measured mechanism: `screen_probe` splits a band by
column profile and reports each element's extent, centre and colour composition
from native pixels. Measured on this display it reports Edge at
**x 531..572, centre 552, blue 49% / cyan 26% / green 25%** — a number no amount
of care on the 1280-wide view would have produced.

Verified end to end: probe → mark → real click opened
`新建标签页 - 个人 - Microsoft Edge [Chrome_WidgetWin_1]`, with
`MSTaskSwWClass` under the cursor and `exact=true` on the cursor read-back.

## One round, in order

1. `screen_capture` — live screen, opens the round.
2. `screen_overlay_grid` — coordinate grid.
3. `screen_compress` — the image the agent reads.
4. For a small element in a dense row: **`screen_probe` the band and use the
   measured centre** — do not read a coordinate off the image.
5. Otherwise `screen_zoom` the region and read it magnified. The zoom is a
   magnifying glass for placing the click; it is never evidence of the screen's
   state.
6. `screen_ask_ai` → `screen_map_to_screen` when a visual coordinate was used.
7. `screen_mark_verify` — red crosshair, measured.
8. `screen_do` — the input.
9. `screen_capture` again — the FULL screen, immediately, to see what the input
   did. This is the only frame that can confirm the final state: a zoom covers
   one rectangle and never counts as the look at a result.
10. `screen_cleanup_round` — no image left behind, and refused until step 9 has
    happened.

## A click is not evidence of its own result

`screen_do` reports a luma drift at the clicked point, the window under the
cursor, and whether the surroundings moved — all measured, all true, and none of
them an answer to *what is the screen showing now*. A click that opened a dialog
and a click that landed on a dead control both look fine from the click's own
account, so the result is only ever read from a later frame — and that frame has
to be the whole screen:

- Every delivered input is recorded as **unconfirmed** (a `dry_run` is not: it
  delivers nothing).
- A **full-screen `screen_capture`** clears the ledger and names the input it is
  now looking at the result of, so the agent is told what it is confirming
  instead of having to infer it.
- **`screen_zoom` never clears it.** A zoom magnifies one rectangle and says
  nothing about the rest of the screen, so it cannot be the look at a result and
  must never be mixed with a full-screen frame to decide what is on screen. It is
  a magnifying glass for placing a click, and that is all it is.
- **`screen_cleanup_round` refuses to close a round over unconfirmed input**, so
  a round cannot be reported as finished on a result nobody has seen. The only
  way past it is `skip_confirmation: true`, which exists for an abandoned target
  and is recorded in the cleanup result.

## Why misclicks do not happen

The guarantee is a chain of refusals, each of which stops the action instead of
guessing:

- **The click uses the verified coordinate, not an argument.** `screen_do`
  ignores click coordinates entirely and acts on the point `screen_mark_verify`
  recorded, so there is no path by which a different number reaches the mouse.
- **Physical pixels throughout.** The process is forced to Per-Monitor-V2 DPI
  awareness, so capture, metrics, and synthesized coordinates share one space.
  Without it a 175 % display reports 1463×914 logical against a 2560×1600
  physical screen and every click lands at 57 % of its intended position.
- **The cursor is read back before the button moves.** `SendInput` normalizes
  into a 0..65535 grid and can land a pixel off at the screen's far edge; the
  position is verified and corrected via `SetCursorPos`, and a cursor that will
  not stay on the verified pixel aborts the click.
- **A moved screen cancels the click.** A 16×16 luma fingerprint of the area
  under the target is compared immediately before input; drift beyond the budget
  means the verified point is no longer the element, so nothing is clicked.
- **Edge targets are refused, not approximated.** A marker closer to an edge
  than its own half-extent is clipped, and a clipped marker's measured centre is
  off: measured 0.2 px at 12 px from an edge, 1.1 px at 8 px, 3.0 px at 1 px.
- **`SendInput` failure is reported as a failure.** A UIPI block
  (`ERROR_ACCESS_DENIED`) is named for what it is, rather than leaving the agent
  to assume a click happened.
- **The result says whether anything reacted.** The area around the target is
  re-measured after the click; "nothing changed at the target" is reported
  instead of being passed off as success.
- **Cleanup is verified, not attempted.** The directory is re-read after
  deletion and the round fails if an image survives.

## Composition notes

The plugin provides no service — it consumes the host `tools` registry and
registers into this preset's layer — so its row carries no `isolate` realm.
Adding one would put the registry out of reach and the row would never activate.
It resolves `koffi` (Win32) and `sharp` (imaging) from the installed harness
rather than from its own directory, so the preset keeps working if it is copied
or moved.

The composition names `./screen-control-plugin/plugin/index.mjs`, resolved
against the composition's own directory. That relative path is what makes the
containment real: the ten capabilities land in this preset's layer of the host
tool registry, so they exist for an agent composed from this preset and are
absent from every other agent in the process. There is no global registration to
leak through.

Tool definitions are written in the harness's author-facing dialect and compiled
at registration through `defineTool` from `@deepseek-ai/dsh-tools`, which is
resolved from the installed harness like the other dependencies. This is not
optional: the registry stores a compiled `ToolDefinition` and validates it, so
`parameters` must arrive as object-rooted raw JSON Schema
(`required: true` marks a mandatory field and is stripped from the property) and
`output.schema` uses the `json` wildcard, which compiles to the annotation-only
form. Registering the author-facing spec directly fails the mount with
"unsupported JSON schema". Compiling also buys argument validation for free:
a call missing a required field is rejected before `execute` runs.

`preset.yml` carries the display name and description; the plugin's source sits
beside it under `screen-control-plugin/plugin/`.
