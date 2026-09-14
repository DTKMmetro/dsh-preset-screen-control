/**
 * The ten capabilities this preset adds to its agent.
 *
 * They are deliberately atomic rather than one "do the thing" tool, because
 * each one is also a checkpoint: the tool that maps coordinates refuses to
 * invent a ratio it was not given, the tool that clicks refuses to run without
 * a verification that is still fresh, and the tool that reports success has
 * already proved where the cursor landed. Splitting them is what makes the
 * no-misclick guarantee enforceable instead of aspirational.
 *
 * @module screen-control/tools
 */

import { hexToRgb, planCompression, gridSpacing, maxEdgeFor, imageToScreen, screenToImage, frameScale, frameRegion, buildGridSvg, paintCrosshair, detectMark, measureBlobs } from './imaging.mjs'
import { validateTarget } from './round.mjs'
import { VIRTUAL_KEYS } from './win32.mjs'

const text = (value) => [{ type: 'text', text: value }]

/**
 * Attach a frame to this tool result.
 *
 * Returns the content blocks for the image plus the text that describes which
 * form was used. The image travels as an image block when the deployment has an
 * attachment store — see delivery.mjs for why that matters — and the text says
 * so plainly instead of leaving the model to infer it from a wall of base64.
 */
async function offerImage(delivery, exec, png, label, inline) {
  if (delivery === null || delivery === undefined) return []
  const offered = await delivery.offer(exec.callId, png, label)
  const blocks = [{ type: 'text', text: `\n${offered.text}\n` }]
  if (offered.base64 !== null && inline) {
    blocks.push({ type: 'text', text: `data:image/png;base64,${offered.base64}` })
  }
  return blocks
}

function round(value, digits = 4) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function rect(meta) {
  const region = frameRegion(meta)
  return `[${round(region.x, 1)}, ${round(region.y, 1)}] .. [${round(region.x + region.width - 1, 1)}, ${round(region.y + region.height - 1, 1)}]`
}

/**
 * The orientation block every capture-shaped result carries.
 *
 * It states the mapping so the model never has to infer it, and it states the
 * label convention so a coordinate can be reported directly off the image.
 *
 * Exactly ONE ratio appears here, and it is always image-pixels-per-desktop-
 * pixel. An earlier version also printed the display's DPI scaling as
 * `desktop scale 1.75x`, which is the reciprocal quantity under the same word:
 * a caller that reads both lines and uses the wrong one converts a coordinate
 * by 1.75 x 1.14 instead of 1/0.5, which put a real attempt 386 px away from a
 * window's close button and made it click the page behind it instead. The
 * display scaling is not needed to convert anything, so it is gone.
 */
function orientation(round_) {
  const meta = round_.meta
  const scale = frameScale(meta)
  const zoom = meta.zoom === undefined || meta.zoom === null ? 1 : meta.zoom
  return [
    `round ${String(round_.round)} | frame ${String(meta.imageWidth)}x${String(meta.imageHeight)} px, desktop region (${String(meta.originX)}, ${String(meta.originY)})`,
    `CONVERSION: desktop = image / ${String(round(scale, 6))} + origin  (${String(round(scale, 6))} image px per desktop px${zoom === 1 ? '' : `, from zoom ${String(zoom)}x then compression ${String(round(meta.ratio, 6))}`})`,
    `verify: image (0, 0) -> desktop (${String(meta.originX)}, ${String(meta.originY)}); image (${String(meta.imageWidth - 1)}, ${String(meta.imageHeight - 1)}) -> desktop (${String(round((meta.imageWidth - 1) / scale + meta.originX, 1))}, ${String(round((meta.imageHeight - 1) / scale + meta.originY, 1))})`,
    'every grid label is a REAL desktop coordinate: the line labelled x1200 is desktop x = 1200',
    `valid desktop targets: ${rect(meta)} | markers refused within ${String(meta.minTargetMargin)} px of an edge`,
    `display: ${String(meta.monitorCount)} monitor(s) at ${String(meta.dpi)} dpi — this is the panel's own scaling and is ALREADY accounted for above; do not divide by it`,
  ].join('\n')
}

export function buildTools({ win, sharp, store, sessionId, options, delivery = null }) {
  const inline = options.inlineImages !== false

  /** Capture the region, encode the full-resolution PNG, and open a round. */
  async function capture(options_) {
    const region = win.selectRegion(options_?.monitorIndex)
    const snapshot = win.displaySnapshot()
    const raster = win.captureRaw(region)
    const png = await sharp(raster.data, {
      raw: { width: raster.width, height: raster.height, channels: raster.channels },
    }).png({ compressionLevel: 6 }).toBuffer()

    const meta = {
      originX: region.x,
      originY: region.y,
      imageWidth: raster.width,
      imageHeight: raster.height,
      ratio: 1,
      zoom: 1,
      // The rectangle this round's capture covers, so a later zoom clips to it
      // instead of asking for pixels outside the desktop.
      captureRegion: { x: region.x, y: region.y, width: region.width, height: region.height },
      dpi: snapshot.dpi,
      scaleFactor: snapshot.scaleFactor,
      awareness: snapshot.awareness,
      monitorCount: snapshot.monitorCount,
      monitorIndex: region.monitor === null ? null : region.monitor.index,
      regionKind: region.kind,
      minTargetMargin: store.minTargetMargin,
      // The geometry every coordinate in this round is computed against. A
      // resolution or monitor-count change invalidates all of them, and the
      // only way to notice is to record what it was.
      geometry: {
        virtual: { ...snapshot.virtual },
        dpi: snapshot.dpi,
        monitorCount: snapshot.monitorCount,
      },
    }

    const { round: round_, abandoned } = store.begin({ region, meta }, sessionId)
    const path = await store.writeFile(round_, 'capture', png)
    round_.meta = meta
    store.setFrame(round_, {
      originX: region.x,
      originY: region.y,
      ratio: 1,
      zoom: 1,
      imageWidth: raster.width,
      imageHeight: raster.height,
    })
    round_.capture = { ...round_.capture, path, width: raster.width, height: raster.height, bytes: png.length }

    if (abandoned !== null && abandoned.files.length > 0) {
      store.note(round_, `previous round ${String(abandoned.round)} was still open; its ${String(abandoned.files.length)} file(s) are reported as residue and are removed by cleanup_round(all_rounds)`)
      round_.carriedOver = abandoned
    }

    return { round: round_, path, png, meta, snapshot, raster }
  }

  // ── 1. capture_fullscreen ─────────────────────────────────────────────────

  const captureFullscreen = {
    name: 'screen_capture',
    description: [
      'Capture what the display is actually showing right now — the composited frame, equivalent to PrtSc, taken from the screen device context with GDI BitBlt (never a window handle, never a re-render).',
      'Opens a new round and writes the full-resolution PNG under the preset screenshots directory. Every later capability in this round refers to this exact frame.',
      'Call this first, and again at the start of each new target. Pass monitor_index only to restrict the capture to one monitor of a multi-display desktop; the default covers the entire virtual desktop so no display is cropped out.',
      'It is also the ONLY confirmation frame, which is why it comes twice: take it again immediately after screen_do, read what the screen now shows there, and state that as the result. A zoomed frame cannot do that job — a zoom covers one rectangle — and screen_cleanup_round refuses to close a round until this capture has been taken.',
      'Returns the physical desktop geometry, the DPI scale factor, and the captured image.',
    ].join(' '),
    parameters: {
      monitor_index: { type: 'number', description: 'Zero-based monitor index for a multi-display desktop. Omit to capture the whole virtual desktop.' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => text(value) },
    async execute(args) {
      const { round: round_, png, meta, snapshot } = await capture({ monitorIndex: args.monitor_index })
      // A full-screen capture is the only frame that answers "what is the screen
      // showing now", so it is what settles any input that was delivered and not
      // looked at afterwards. A zoom cannot: it magnifies one rectangle and
      // covers nothing else. Taking it here is what later lets the round close.
      const confirmed = store.confirmInputs(sessionId)
      const body = [
        `captured the live screen at ${new Date().toISOString()}`,
        `file: ${round_.capture.path} (${String(round_.capture.bytes)} bytes)`,
        orientation(round_),
        `capture covers: ${meta.regionKind === 'monitor' ? `monitor ${String(meta.monitorIndex)} only` : 'the entire virtual desktop (all monitors)'}`,
        `monitors: ${snapshot.monitors.map((m) => `#${String(m.index)} ${String(m.width)}x${String(m.height)} at (${String(m.left)}, ${String(m.top)})${m.scale === null ? '' : ` ${String(m.scale)}x`}`).join(' | ')}`,
      ]
      if (confirmed.length > 0) {
        body.push(
          '',
          `CONFIRMATION FRAME: this whole-screen capture is the first look at ${String(confirmed.length)} delivered input(s) that no capture had covered, so it — not the input — is the evidence of what they did:`,
          ...confirmed.map((entry) => `- round ${String(entry.round)}: ${entry.action}${entry.screenX === null || entry.screenX === undefined ? ' (delivered to the focused window)' : ` at desktop (${String(entry.screenX)}, ${String(entry.screenY)})`} at ${entry.at}`),
          'Read THIS frame and state what the screen now shows. If it is not the expected result, report that instead of assuming the input worked.',
        )
      }
      body.push('', 'Next: screen_overlay_grid to add the coordinate grid, then screen_compress to produce the image you will read.')
      return body.join('\n')
    },
  }

  // ── 2. overlay_grid ───────────────────────────────────────────────────────

  const overlayGrid = {
    name: 'screen_overlay_grid',
    description: [
      'Draw an evenly spaced coordinate grid over the current round\'s capture, labelling every intersection with its REAL desktop coordinate.',
      'Grid spacing is adaptive: a cell spans 50 px at the display\'s own scaling when the screen\'s short edge is below 1080, otherwise 100 px. Labels print absolute desktop pixels (x1200, y800), so a target can be read straight off the image without counting lines.',
      'Run this after screen_capture and before screen_compress.',
    ].join(' '),
    parameters: {
      spacing: { type: 'number', description: 'Override the adaptive logical grid spacing in px. Omit to use the adaptive value.' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => text(value) },
    async execute(args) {
      const round_ = store.require(sessionId)
      const meta = round_.meta
      const logicalShort = Math.min(meta.imageWidth, meta.imageHeight) / meta.scaleFactor
      const spacing = Number.isFinite(args.spacing) && args.spacing > 0
        ? Math.round(args.spacing)
        : gridSpacing(logicalShort)
      const spacingPx = Math.max(24, Math.round(spacing * meta.ratio))

      const svg = buildGridSvg({
        originX: meta.originX,
        originY: meta.originY,
        width: meta.imageWidth,
        height: meta.imageHeight,
        spacing: spacingPx,
        ratio: meta.ratio,
        scaleFactor: meta.scaleFactor,
        labelPrefix: `r${String(round_.round)} grid ${String(spacing)}px logical / ${String(spacingPx)}px image`,
      })

      const composited = await sharp(round_.capture.path)
        .composite([{ input: svg, top: 0, left: 0 }])
        .png({ compressionLevel: 6 })
        .toBuffer()

      const path = await store.writeFile(round_, 'grid', composited)
      round_.grid = {
        path,
        spacing,
        spacingPx,
        minorPerCell: 1,
        originX: meta.originX,
        originY: meta.originY,
        width: meta.imageWidth,
        height: meta.imageHeight,
        ratio: meta.ratio,
      }
      round_.meta.grid = round_.grid

      return [
        'grid overlaid on the full-resolution capture',
        `file: ${path}`,
        `spacing: ${String(spacingPx)} image px between lines = ${String(Math.round(spacingPx / (round_.meta.zoom === undefined || round_.meta.zoom === null ? 1 : round_.meta.zoom)))} desktop px per cell (chosen so a cell stays ${String(spacing)} px at the display's own scaling)`,
        `labels: x/y prefixes carry the real desktop coordinate of that line (x0 is desktop 0, not image 0)`,
        orientation(round_),
        '',
        'Next: screen_compress to scale it down for reading.',
      ].join('\n')
    },
  }

  // ── 3. zoom (magnify a region) ────────────────────────────────────────────

  const zoom = {
    name: 'screen_zoom',
    description: [
      'Magnify a region of the screen so small elements can actually be identified — the fix for "that icon is too small to tell apart" at full-screen scale.',
      'Captures the given desktop rectangle and scales it up by zoom, so ONE desktop pixel becomes zoom image pixels. The frame then covers only that rectangle: grid, mapping, marker and click all continue to use REAL desktop coordinates, so nothing else in the round changes.',
      'Use it whenever the compressed full-screen image leaves a target ambiguous: zoom the strip or panel it lives in, read the element off the magnified view, then report its grid coordinate as usual. The magnified frame is deliberately NOT shrunk back down by the compression cap, so the detail survives.',
      'It is a magnifying glass for placing a click and nothing more: a zoomed frame is never evidence of the screen\'s state, so after any input the confirmation always comes from a fresh screen_capture.',
      'Call screen_capture again to return to the full screen, or screen_zoom elsewhere for another area.',
    ].join(' '),
    parameters: {
      x: { type: 'number', required: true, description: 'Left edge of the region, as a real desktop coordinate.' },
      y: { type: 'number', required: true, description: 'Top edge of the region, as a real desktop coordinate.' },
      width: { type: 'number', required: true, description: 'Region width in desktop pixels.' },
      height: { type: 'number', required: true, description: 'Region height in desktop pixels.' },
      zoom: { type: 'number', description: 'Magnification, 1-8. Defaults to 4. The resulting image must stay under about 40 megapixels; pick a smaller region for a bigger magnification.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => text(value),
    },
    // Sibling of `output`, not a member of it — see screen_mark_verify.
    finalizeContent: (exec) => {
      const image = delivery === null ? null : delivery.take(exec.callId)
      return image === null ? undefined : [image]
    },
    async execute(args, exec) {
      const round_ = store.require(sessionId)
      const meta = round_.meta
      const zoomFactor = Number.isFinite(args.zoom) && args.zoom > 0 ? Math.min(8, Math.max(1, args.zoom)) : 4

      const x = Math.round(args.x)
      const y = Math.round(args.y)
      const width = Math.round(args.width)
      const height = Math.round(args.height)
      if (![x, y, width, height].every(Number.isFinite) || width < 8 || height < 8) {
        throw new Error('screen-control: screen_zoom needs finite x, y and a region at least 8x8 desktop pixels')
      }

      // Clamp to the desktop area this round covers, so a zoom never asks the
      // capture path for pixels outside the desktop.
      const full = meta.captureRegion
      const left = Math.max(x, full.x)
      const top = Math.max(y, full.y)
      const right = Math.min(x + width, full.x + full.width)
      const bottom = Math.min(y + height, full.y + full.height)
      if (right - left < 8 || bottom - top < 8) {
        throw new Error(
          `screen-control: the requested region (${String(x)}, ${String(y)}) ${String(width)}x${String(height)} does not overlap the desktop area this round covers `
          + `${rect({ ...meta, originX: full.x, originY: full.y, imageWidth: full.width, imageHeight: full.height, ratio: 1, zoom: 1 })}`,
        )
      }

      const crop = { x: left, y: top, width: right - left, height: bottom - top }
      const outWidth = Math.round(crop.width * zoomFactor)
      const outHeight = Math.round(crop.height * zoomFactor)
      if (outWidth * outHeight > 40_000_000) {
        throw new Error(
          `screen-control: zoom ${String(zoomFactor)}x of ${String(crop.width)}x${String(crop.height)} would be ${String(outWidth)}x${String(outHeight)} px, too large to read. `
          + `Use a region of at most about ${String(Math.floor(Math.sqrt(40_000_000 / (zoomFactor * zoomFactor))))} px per side at this magnification.`,
        )
      }
      // StretchBlt cannot scale an axis by more than 2^24/width, and upscaling an
      // axis by more than 8x is beyond what any display needs.
      if (crop.width * zoomFactor > 16_000_000 || crop.height * zoomFactor > 16_000_000) {
        throw new Error('screen-control: that region is too wide to magnify; narrow it and try again')
      }

      // Capture the magnified raster and a fresh unmarked copy of the same
      // rectangle for the pixel detector, both from the live screen.
      const magnified = win.captureRaw(crop, { width: outWidth, height: outHeight })

      const grid = { ...meta, originX: crop.x, originY: crop.y, imageWidth: outWidth, imageHeight: outHeight, ratio: 1, zoom: zoomFactor }
      const spacingPx = Math.max(40, Math.round(64 * zoomFactor))
      const svg = buildGridSvg({
        originX: crop.x,
        originY: crop.y,
        width: outWidth,
        height: outHeight,
        spacing: spacingPx,
        ratio: 1,
        zoom: zoomFactor,
        scaleFactor: meta.scaleFactor,
        labelPrefix: `r${String(round_.round)} zoom ${String(zoomFactor)}x  ${String(crop.width)}x${String(crop.height)} desktop px`,
      })

      const composited = await sharp(magnified.data, {
        raw: { width: magnified.width, height: magnified.height, channels: magnified.channels },
      }).composite([{ input: svg, top: 0, left: 0 }]).png({ compressionLevel: 6 }).toBuffer()

      const path = await store.writeFile(round_, 'zoom', composited)

      // The round's working frame becomes the magnified rectangle. `setFrame`
      // clears the previous target and verification, because a point chosen on
      // the full screen means something different in a magnified frame.
      const view = store.setFrame(round_, {
        originX: crop.x,
        originY: crop.y,
        ratio: 1,
        zoom: zoomFactor,
        imageWidth: outWidth,
        imageHeight: outHeight,
      })
      round_.zoom = { path, factor: zoomFactor, crop, width: outWidth, height: outHeight }
      round_.grid = {
        path,
        spacing: spacingPx,
        spacingPx,
        originX: crop.x,
        originY: crop.y,
        width: outWidth,
        height: outHeight,
        ratio: 1,
        zoom: zoomFactor,
        desktopPerCell: Math.round(spacingPx / zoomFactor),
      }
      round_.compressed = null
      store.note(round_, `zoom ${String(zoomFactor)}x on ${String(crop.width)}x${String(crop.height)} at (${String(crop.x)}, ${String(crop.y)})`)

      const blocks = await offerImage(delivery, exec, composited, path, inline)
      return [
        `magnified ${String(zoomFactor)}x: desktop ${String(crop.width)}x${String(crop.height)} at (${String(crop.x)}, ${String(crop.y)}) -> ${String(outWidth)}x${String(outHeight)} px`,
        `file: ${path} (${String(composited.length)} bytes)`,
        `one desktop pixel is now ${String(zoomFactor)} image pixels; grid cells are ${String(spacingPx / zoomFactor)} desktop px, each labelled with its real coordinate`,
        orientation(round_),
        '',
        'Read the element off this magnified view and report its IMAGE pixels (gx, gy) through screen_ask_ai, measured from this image top-left.',
        'The frame now covers only the zoomed rectangle; screen_map_to_screen and screen_mark_verify still take and return real desktop coordinates.',
        'THIS IS A LOOKING GLASS, NOT A VIEW OF THE SCREEN. It exists to place a click precisely, and it covers one rectangle, so it cannot tell you what the screen is showing overall. Never judge the state of the screen from this frame, never mix it with a full-screen frame to decide what is on screen, and never use it as the look at the result of an input: screen_cleanup_round refuses to close a round whose input was not followed by a full-screen screen_capture.',
        'Call screen_capture again to go back to the whole screen.',
      ].join('\n') + blocks.map((block) => `\n${block.text}`).join('')
    },
  }

  // ── 4. probe (measure elements instead of guessing them) ──────────────────

  const probe = {
    name: 'screen_probe',
    description: [
      'MEASURE the elements in a strip of screen instead of reading their coordinates off the image. Returns each element\'s exact desktop position, size, and colour composition, computed from the native pixels.',
      'This exists because the most reliable way to get a misclick is to eyeball a small icon in a downscaled screenshot. A taskbar icon is about 40 desktop px wide and roughly 7 px in the compressed full-screen view; reading its centre off that view is where a click lands hundreds of pixels away. On a dense row — taskbar, toolbar, ribbon, tab strip — use this tool and target the reported centre.',
      'Give the band that contains the row: for the Windows taskbar, x 0, y 1516, width 2560, height 84 on this display. Elements are separated by their column profile along the band.',
      'Identify the element by its colour composition — for example Edge is the one that is mostly blue with cyan and green, not by counting positions from an image.',
    ].join(' '),
    parameters: {
      x: { type: 'number', required: true, description: 'Left edge of the band, as a real desktop coordinate.' },
      y: { type: 'number', required: true, description: 'Top edge of the band, as a real desktop coordinate.' },
      width: { type: 'number', required: true, description: 'Band width in desktop pixels.' },
      height: { type: 'number', required: true, description: 'Band height in desktop pixels.' },
      axis: { type: 'string', description: '\'x\' for a horizontal row of elements (default), \'y\' for a vertical column.' },
      threshold: { type: 'number', description: 'Luma above which a pixel counts as element rather than background. Defaults to 70.' },
      min_size: { type: 'number', description: 'Smallest element size in desktop px to report. Defaults to 8.' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => text(value) },
    async execute(args) {
      const round_ = store.require(sessionId)
      const meta = round_.meta
      const full = meta.captureRegion

      const x = Math.round(args.x)
      const y = Math.round(args.y)
      const width = Math.round(args.width)
      const height = Math.round(args.height)
      if (![x, y, width, height].every(Number.isFinite) || width < 4 || height < 4) {
        throw new Error('screen-control: screen_probe needs finite x, y and a band at least 4x4 desktop pixels')
      }
      if (width * height > 8_000_000) {
        throw new Error('screen-control: that band is too large to measure; narrow it to the row you care about')
      }

      const left = Math.max(x, full.x)
      const top = Math.max(y, full.y)
      const right = Math.min(x + width, full.x + full.width)
      const bottom = Math.min(y + height, full.y + full.height)
      if (right - left < 4 || bottom - top < 4) {
        throw new Error(`screen-control: the requested band does not overlap the desktop area this round covers, which starts at (${String(full.x)}, ${String(full.y)}) and is ${String(full.width)}x${String(full.height)} px`)
      }

      const band = { x: left, y: top, width: right - left, height: bottom - top }
      const raster = win.captureRaw(band)
      const axis = String(args.axis ?? 'x').toLowerCase() === 'y' ? 'y' : 'x'
      const blobs = measureBlobs(raster, {
        axis,
        threshold: Number.isFinite(args.threshold) ? args.threshold : 70,
        minWidth: Number.isFinite(args.min_size) ? Math.max(1, Math.round(args.min_size)) : 8,
      })

      store.note(round_, `probe ${String(band.width)}x${String(band.height)} at (${String(band.x)}, ${String(band.y)}): ${String(blobs.length)} element(s)`)

      if (blobs.length === 0) {
        return [
          `measured ${String(band.width)}x${String(band.height)} desktop px at (${String(band.x)}, ${String(band.y)}) along the ${axis} axis`,
          'no element stood out above the background threshold.',
          'Either the band holds no elements, or they are dimmer than the threshold. Raise the band to cover the row exactly, or lower threshold (try 40) for a dark theme.',
        ].join('\n')
      }

      const lines = [
        `measured ${String(band.width)}x${String(band.height)} desktop px at (${String(band.x)}, ${String(band.y)}), separated along the ${axis} axis`,
        `${String(blobs.length)} element(s) found, each with its exact desktop centre MEASURED on both axes:`,
        '',
      ]
      for (const blob of blobs) {
        const along = band[axis === 'x' ? 'x' : 'y'] + blob.centre
        const across = band[axis === 'x' ? 'y' : 'x'] + blob.crossCentre
        const cx = axis === 'x' ? along : across
        const cy = axis === 'x' ? across : along
        const span = axis === 'x'
          ? `x ${String(band.x + blob.from)}..${String(band.x + blob.to)}, y ${String(band.y + blob.crossFrom)}..${String(band.y + blob.crossTo)}`
          : `y ${String(band.y + blob.from)}..${String(band.y + blob.to)}, x ${String(band.x + blob.crossFrom)}..${String(band.x + blob.crossTo)}`
        const colours = blob.colours.map((entry) => `${entry.name} ${String(entry.share)}%`).join(', ')
        lines.push(`#${String(blob.index).padStart(2)}  ${span}  centre (${String(cx)}, ${String(cy)})  size ${String(blob.size)} px  avg rgb(${(blob.averageRgb ?? []).join(',')})  [${colours}]`)
      }
      const allCrossMeasured = blobs.every((blob) => blob.crossMeasured)
      lines.push(
        '',
        'Those centres are measured on BOTH axes from each element\'s own pixels — click the centre as printed.',
        allCrossMeasured
          ? 'The band is only a search window; its midpoint is NOT used, so a band with slack is harmless.'
          : 'Some elements filled the whole band depth, so their cross-axis centre equals the band midpoint; that is measured, not assumed.',
        'Identify your element by its colour composition. screen_map_to_screen is not needed — these are already real desktop coordinates.',
      )
      return lines.join('\n')
    },
  }

  // ── 5. compress ───────────────────────────────────────────────────────────
  const compress = {
    name: 'screen_compress',
    description: [
      'Scale the current round\'s grid image down for reading.',
      'The cap is adaptive: when the source long edge exceeds 1920 the long edge becomes 1280, otherwise 1600. When the source is ALREADY within the cap the image is left untouched (ratio 1) — which is deliberate, because a magnified screen_zoom frame must keep its detail rather than being shrunk back to full-screen scale.',
      'Run this after screen_overlay_grid. The returned image is the one to reason about: image coordinates you report are in THIS image.',
    ].join(' '),
    parameters: {
      max_edge: { type: 'number', description: 'Override the adaptive long-edge cap in px.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => text(value),
    },
    // Sibling of `output`, not a member of it — see screen_mark_verify.
    finalizeContent: (exec) => {
      const image = delivery === null ? null : delivery.take(exec.callId)
      return image === null ? undefined : [image]
    },
    async execute(args, exec) {
      const round_ = store.require(sessionId)
      if (round_.grid === null) {
        // Name the step that is actually missing. This fires most often when a
        // caller drives the tools one at a time and re-opens a round between
        // calls, so it discards the grid it had already made and then asks for a
        // compression of it. Saying only "needs the grid image" sends that caller
        // hunting for a missing grid instead of at the capture that discarded it.
        const produced = round_.files.map((file) => file.stage).join(', ')
        throw new Error(
          'screen-control: screen_compress needs the grid image, and this round has not overlaid one yet. '
          + `Round ${String(round_.round)} has produced so far: ${produced === '' ? 'nothing' : produced}. `
          + 'Run screen_overlay_grid after screen_capture within the SAME round — a new screen_capture opens a fresh round '
          + 'and discards the previous grid, capture and verification.',
        )
      }
      const meta = round_.meta
      const sourceWidth = meta.imageWidth
      const sourceHeight = meta.imageHeight
      const longEdge = Math.max(sourceWidth, sourceHeight)
      // A magnified frame is never compressed by default. `maxEdgeFor` is derived
      // from the source size, so applying it to a zoom would shrink the magnified
      // view straight back to full-screen scale and destroy exactly the detail the
      // zoom was taken to obtain. An explicit max_edge still overrides.
      const magnified = (meta.zoom === undefined || meta.zoom === null ? 1 : meta.zoom) > 1
      const explicitCap = Number.isFinite(args.max_edge) && args.max_edge > 0
      const cap = explicitCap ? Math.round(args.max_edge) : magnified ? Math.max(longEdge, 4096) : maxEdgeFor(longEdge)
      const plan = planCompression(sourceWidth, sourceHeight, cap)

      const buffer = plan.scaled
        ? await sharp(round_.grid.path)
          .resize(plan.width, plan.height, { fit: 'fill', kernel: 'lanczos3' })
          .png({ compressionLevel: 6, palette: false })
          .toBuffer()
        : await sharp(round_.grid.path).png({ compressionLevel: 6 }).toBuffer()

      const path = await store.writeFile(round_, 'compressed', buffer)
      round_.compressed = {
        path,
        width: plan.width,
        height: plan.height,
        ratio: plan.ratio,
        maxEdge: cap,
        bytes: buffer.length,
      }
      // The frame's ratio is the compression only; the magnification lives in
      // `zoom`, and `frameScale` multiplies them. Deriving both through
      // `setFrame` is what lets a later compression of a magnified frame still
      // resolve to the right desktop pixel.
      store.setFrame(round_, {
        originX: round_.view.originX,
        originY: round_.view.originY,
        ratio: plan.ratio,
        zoom: round_.view.zoom,
        imageWidth: plan.width,
        imageHeight: plan.height,
      })

      const scale = frameScale(round_.meta)
      const zoom = round_.meta.zoom === undefined || round_.meta.zoom === null ? 1 : round_.meta.zoom
      const centerX = Math.round(plan.width / 2)
      const centerY = Math.round(plan.height / 2)
      const blocks = await offerImage(delivery, exec, buffer, path, inline)
      return [
        plan.scaled ? 'compressed for reading' : 'no compression applied — this frame is already within the reading cap, so its detail is preserved',
        `file: ${path} (${String(buffer.length)} bytes)`,
        `grid image ${String(sourceWidth)}x${String(sourceHeight)} -> ${String(plan.width)}x${String(plan.height)} (compression ${String(round(plan.ratio, 6))}${zoom === 1 ? '' : `, zoom ${String(zoom)}x`})`,
        `scale = ${String(round(scale, 6))} image px per desktop px  (screen = image / ${String(round(scale, 6))} + origin)`,
        `example: image (${String(centerX)}, ${String(centerY)}) -> desktop (${String(round(centerX / scale + meta.originX, 1))}, ${String(round(centerY / scale + meta.originY, 1))})`,
        orientation(round_),
        '',
        'LOOP: read the image, name the target, and report its image pixels (gx, gy) measured from the image top-left. The labels on the lines give the real desktop value of any line.',
        'If the target is still too small to identify with certainty, do NOT guess — call screen_zoom on the strip or panel containing it and read it there.',
      ].join('\n') + blocks.map((block) => `\n${block.text}`).join('')
    },
  }

  // ── 5. ask_ai ─────────────────────────────────────────────────────────────

  const askAi = {
    name: 'screen_ask_ai',
    description: [
      'Record the visual analysis of the compressed grid image and, when you have it, the target\'s grid pixel coordinate.',
      'This is the step where YOU are the model that reads the image: no second model is called, and no coordinate is invented. Pass the target\'s grid pixels (gx, gy) measured from the compressed image top-left, or omit them to receive the reading protocol when you cannot identify the target yet.',
      'A reported coordinate is recorded as this round\'s located target and screen_map_to_screen will convert it. Reporting a coordinate is what lets the mapping step detect a mistaken reading.',
    ].join(' '),
    parameters: {
      prompt: { type: 'string', required: true, description: 'What is being looked for, in your own words. Recorded for the round log.' },
      gx: { type: 'number', description: 'Target x in compressed-image pixels, measured from the image top-left.' },
      gy: { type: 'number', description: 'Target y in compressed-image pixels, measured from the image top-left.' },
      target: { type: 'string', description: 'Short description of the element you identified.' },
      confidence: { type: 'string', description: 'high | medium | low — your confidence that the coordinate is on the intended element.' },
      alternatives: { type: 'string', description: 'Backup coordinates or a description of them, if any.' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => text(value) },
    async execute(args) {
      const round_ = store.require(sessionId)
      // Either path produces a readable frame: the compressed full screen, or a
      // magnified region from screen_zoom.
      const frame = round_.compressed !== null
        ? { path: round_.compressed.path, width: round_.compressed.width, height: round_.compressed.height, kind: 'compressed full screen' }
        : round_.zoom !== null
          ? { path: round_.zoom.path, width: round_.zoom.width, height: round_.zoom.height, kind: `zoom ${String(round_.zoom.factor)}x` }
          : null
      if (frame === null) {
        throw new Error('screen-control: screen_ask_ai needs a readable frame; run screen_compress after screen_overlay_grid, or screen_zoom a region.')
      }
      const meta = round_.meta
      const hasPoint = Number.isFinite(args.gx) && Number.isFinite(args.gy)

      store.note(round_, `ask_ai: ${args.prompt}${hasPoint ? ` -> image (${String(args.gx)}, ${String(args.gy)})` : ' (no coordinate reported)'}`)

      if (!hasPoint) {
        const scaleNow = frameScale(meta)
        return [
          'no coordinate reported yet — reading protocol:',
          `image: ${frame.path} (${String(frame.width)}x${String(frame.height)} px, ${frame.kind})`,
          `scale: ${String(round(scaleNow, 6))} image px per desktop px; grid labels print real desktop coordinates`,
          '',
          '1. read the image above (or with read_image) and find the element you were asked to act on;',
          '2. pick the point to click — the centre of the control, not its edge;',
          '3. measure its IMAGE pixels (gx, gy) from the image top-left. Use the nearest labelled grid line and add the offset inside that cell;',
          '   Measure against the LABELS, not against your impression of the picture. A viewer may show the image scaled to fit, so its apparent width is not the image width, and a coordinate computed from the rendered size is wrong by that scale factor — the most common way a click lands tens or hundreds of pixels away while every later check confirms it. The labels are printed into the pixels, so they survive any rescaling: read the two nearest labelled lines and interpolate between them.',
          '4. call screen_ask_ai again with gx, gy, target, and confidence so the coordinate is recorded.',
          'If the element is too small to identify with certainty, do NOT guess: call screen_zoom on the strip or panel containing it and read it there.',
          'If it is not visible at all, say so instead of guessing: change state or scroll within the round and capture again.',
        ].join('\n')
      }

      const mapped = imageToScreen(args.gx, args.gy, meta)
      round_.locatedTarget = {
        gx: args.gx,
        gy: args.gy,
        target: args.target ?? null,
        confidence: args.confidence ?? null,
        prompt: args.prompt,
        screenX: round(mapped.x, 2),
        screenY: round(mapped.y, 2),
      }
      round_.locatedAt = Date.now()

      return [
        `recorded target${args.target === undefined ? '' : `: ${args.target}`}${args.confidence === undefined ? '' : ` (confidence ${args.confidence})`}`,
        `grid (${String(args.gx)}, ${String(args.gy)}) -> desktop (${String(round(mapped.x, 2))}, ${String(round(mapped.y, 2))})`,
        `in-image check: that desktop point maps back to grid (${String(round(screenToImage(mapped.x, mapped.y, meta).gx, 2))}, ${String(round(screenToImage(mapped.x, mapped.y, meta).gy, 2))})`,
        orientation(round_),
        '',
        'Next: screen_map_to_screen with these grid coordinates. It will compare your reading against its own conversion and report any discrepancy.',
      ].join('\n')
    },
  }

  // ── 5. map_to_screen ──────────────────────────────────────────────────────

  const mapToScreen = {
    name: 'screen_map_to_screen',
    description: [
      'Convert a grid pixel coordinate from the compressed image into a real desktop coordinate.',
      'Formula: screen = gx / ratio + origin, where ratio is the recorded compression ratio and origin is the captured region\'s top-left on the virtual desktop — negative when a secondary display sits left of or above the primary, and the sign is preserved.',
      'DPI scaling is already resolved: the capture, the metrics, and the coordinates the click uses are all physical desktop pixels. Pass the same gx, gy you reported to screen_ask_ai; a mismatch between the two is reported as a discrepancy rather than silently accepted.',
    ].join(' '),
    parameters: {
      gx: { type: 'number', required: true, description: 'Target x in compressed-image pixels.' },
      gy: { type: 'number', required: true, description: 'Target y in compressed-image pixels.' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => text(value) },
    async execute(args) {
      const round_ = store.require(sessionId)
      if (round_.compressed === null && round_.zoom === null) {
        throw new Error('screen-control: screen_map_to_screen needs a readable frame; run screen_capture, screen_overlay_grid and screen_compress, or screen_zoom a region.')
      }
      const meta = round_.meta
      const mapped = imageToScreen(args.gx, args.gy, meta)
      const back = screenToImage(mapped.x, mapped.y, meta)
      const scale = frameScale(meta)

      const lines = [
        `image (${String(args.gx)}, ${String(args.gy)}) -> desktop (${String(round(mapped.x, 2))}, ${String(round(mapped.y, 2))})`,
        `scale ${String(round(scale, 6))} image px per desktop px | origin (${String(meta.originX)}, ${String(meta.originY)}) | region ${rect(meta)}`,
        `round-trip: image -> screen -> image gives (${String(round(back.gx, 3))}, ${String(round(back.gy, 3))})`,
      ]

      if (round_.locatedTarget !== null) {
        const dx = Math.abs(round_.locatedTarget.gx - args.gx)
        const dy = Math.abs(round_.locatedTarget.gy - args.gy)
        if (dx > 1 || dy > 1) {
          lines.push(
            `DISCREPANCY: screen_ask_ai recorded grid (${String(round_.locatedTarget.gx)}, ${String(round_.locatedTarget.gy)}) `
            + `but this call used (${String(args.gx)}, ${String(args.gy)}) — a difference of (${String(round(dx, 2))}, ${String(round(dy, 2))}) px. `
            + 'Re-read the image and settle on one coordinate before verifying; the two must agree.',
          )
        } else {
          lines.push(`consistent with the coordinate recorded by screen_ask_ai (within ${String(round(Math.max(dx, dy), 2))} px)`)
          round_.locatedTarget.screenX = round(mapped.x, 2)
          round_.locatedTarget.screenY = round(mapped.y, 2)
        }
      } else {
        lines.push('note: no coordinate was recorded by screen_ask_ai for this round; verify this point carefully before clicking.')
      }

      const problems = validateTarget(mapped.x, mapped.y, meta, meta.minTargetMargin)
      if (problems.length > 0) {
        lines.push('', 'REFUSED as a click target:', ...problems.map((problem) => `- ${problem}`))
      } else {
        lines.push(
          '',
          `Next: screen_mark_verify with screen_x=${String(round(mapped.x, 2))}, screen_y=${String(round(mapped.y, 2))}. It draws a red crosshair there, `
          + 'shows it to you, and is the mandatory gate before any input.',
        )
      }
      return lines.join('\n')
    },
  }

  // ── 6. mark_and_verify ────────────────────────────────────────────────────

  const markAndVerify = {
    name: 'screen_mark_verify',
    description: [
      'The mandatory gate before any input. Draws a red crosshair at the exact desktop coordinate that would be clicked, renders the marker into an image, measures where the marker actually landed in pixels, and re-captures the live screen to fingerprint the area.',
      'The marker is drawn at the coordinate itself, so its position is exact by construction; the measurement proves the geometry and the image proves to YOU that the crosshair sits on the intended element. A detection error above the tolerance, a target too close to a screen edge, or a coordinate outside the captured region all fail the verification and refuse the click.',
      'The verification must be the last thing before screen_do; it expires after a short window, and the pre-input fingerprint check refuses the click if the screen under the target changed in the meantime.',
    ].join(' '),
    parameters: {
      screen_x: { type: 'number', required: true, description: 'Target x as a real desktop coordinate, from screen_map_to_screen.' },
      screen_y: { type: 'number', required: true, description: 'Target y as a real desktop coordinate, from screen_map_to_screen.' },
      target: { type: 'string', description: 'What should be at that point, for the round log.' },
      tolerance: { type: 'number', description: 'Maximum allowed marker centroid error in px. Defaults to 2.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => text(value),
    },
    // The frame offered by execute is attached HERE, as a real image block.
    // This must be a sibling of `output`, not a member of it: `defineTool` reads
    // it from the tool definition, and a nested one is silently dropped.
    finalizeContent: (exec) => {
      const image = delivery === null ? null : delivery.take(exec.callId)
      return image === null ? undefined : [image]
    },
    async execute(args, exec) {
      const round_ = store.require(sessionId)
      const meta = round_.meta
      const tolerance = Number.isFinite(args.tolerance) && args.tolerance >= 0 ? args.tolerance : store.markTolerance

      const problems = validateTarget(args.screen_x, args.screen_y, meta, meta.minTargetMargin)
      if (problems.length > 0) {
        round_.verified = null
        round_.verifiedAt = null
        throw new Error(`screen-control: verification refused for round ${String(round_.round)}:\n- ${problems.join('\n- ')}`)
      }

      // A fresh, unmarked capture of the live screen: this is both the backdrop
      // the marker is rendered onto and the drift reference for the click.
      //
      // The backdrop is always captured at 1 image pixel per desktop pixel, even
      // when the working frame is magnified. The magnification belongs to the
      // ROUND's evidence, not to the physical marker: drawing a 25 px crosshair
      // on a 4x view would put a 100 px image-space mark over 25 desktop px of
      // screen, and measuring that would be measuring the renderer rather than
      // the geometry. The magnified view is produced afterwards, from this same
      // unmarked capture, so the marker is magnified with the pixels it sits on.
      const region = round_.zoom === undefined || round_.zoom === null ? round_.capture.region : round_.zoom.crop
      const live = win.captureRaw(region)
      const desktopToImage = meta.zoom === undefined || meta.zoom === null ? 1 : meta.zoom
      const fingerprint = win.patchFingerprint(args.screen_x, args.screen_y)
      const scale = frameScale(meta)

      // One desktop pixel is one pixel of this backdrop, whatever the frame's
      // magnification, so the marker's position and size are in desktop pixels.
      const imageX = Math.round(args.screen_x - meta.originX)
      const imageY = Math.round(args.screen_y - meta.originY)

      const MARK_ARM = 12
      const MARK_THICK = 3

      const marked = {
        data: Buffer.from(live.data),
        width: live.width,
        height: live.height,
        channels: live.channels,
      }
      paintCrosshair(marked, imageX, imageY, hexToRgb('#ff0000'), MARK_ARM, MARK_THICK)

      const detection = detectMark(marked, imageX, imageY, hexToRgb('#ff0000'), MARK_ARM + 10)
      const detectedX = detection.detected ? meta.originX + detection.centroid.x : null
      const detectedY = detection.detected ? meta.originY + detection.centroid.y : null
      const delta = detection.detected
        ? { x: round(detectedX - args.screen_x, 3), y: round(detectedY - args.screen_y, 3) }
        : null

      // A marker whose bounding box is smaller than the one that was painted has
      // been clipped — by a screen edge, or by something overlapping it. Its
      // centroid is then dragged inward by roughly half the clipped amount, so
      // the measurement stops being a measurement of the target.
      const drawnExtent = 2 * MARK_ARM + 1
      const clipped = detection.detected
        && (detection.extent.width < drawnExtent - 2 || detection.extent.height < drawnExtent - 2)
      const withinTolerance = detection.detected && !clipped
        && Math.abs(delta.x) <= tolerance
        && Math.abs(delta.y) <= tolerance

      const png = await sharp(marked.data, {
        raw: { width: marked.width, height: marked.height, channels: marked.channels },
      }).png({ compressionLevel: 6 }).toBuffer()
      const path = await store.writeFile(round_, 'verify', png)

      // The view the model inspects: the same marked pixels, magnified by the
      // frame's zoom when there is one, so the marker and the element under it
      // are visible together at the scale the target was chosen at. The cap is
      // generous precisely so a magnified view is NOT shrunk back down — doing
      // that would throw away the detail the zoom was taken to obtain.
      const viewWidth = Math.round(marked.width * desktopToImage)
      const viewHeight = Math.round(marked.height * desktopToImage)
      const VIEW_BUDGET = 40_000_000
      const viewRatio = Math.min(1, Math.sqrt(VIEW_BUDGET / Math.max(1, viewWidth * viewHeight)))
      const viewPlan = { width: Math.max(1, Math.round(viewWidth * viewRatio)), height: Math.max(1, Math.round(viewHeight * viewRatio)), ratio: viewRatio }
      const viewBuffer = await sharp(marked.data, {
        raw: { width: marked.width, height: marked.height, channels: marked.channels },
      })
        .resize(viewPlan.width, viewPlan.height, { fit: 'fill', kernel: viewRatio < 1 ? 'lanczos3' : 'nearest' })
        .png({ compressionLevel: 6 })
        .toBuffer()
      const viewPath = await store.writeFile(round_, 'verify_view', viewBuffer)

      const lines = [
        `verification of round ${String(round_.round)} at desktop (${String(args.screen_x)}, ${String(args.screen_y)})${args.target === undefined ? '' : ` for "${args.target}"`}`,
        `marker image: ${path}`,
        `inspection view: ${viewPath} (${String(viewPlan.width)}x${String(viewPlan.height)}, ratio ${String(round(viewPlan.ratio, 6))})`,
        `marker centroid measured at desktop (${detectedX === null ? 'not detected' : String(round(detectedX, 3))}, ${detectedY === null ? 'not detected' : String(round(detectedY, 3))}) from ${String(detection.pixels)} marker px`,
        `marker extent: ${detection.detected ? `${String(detection.extent.width)}x${String(detection.extent.height)} px (drawn ${String(drawnExtent)}x${String(drawnExtent)})${clipped ? ' — CLIPPED' : ''}` : 'n/a'}`,
        `centroid offset from target: ${delta === null ? 'n/a' : `(${String(delta.x)}, ${String(delta.y)})`} px, tolerance ${String(tolerance)} px`,
        `live-screen fingerprint: 16x16 luma grid over a 144 px patch, drift budget ${String(store.driftThreshold)}`,
      ]

      if (!withinTolerance) {
        round_.verified = null
        round_.verifiedAt = null
        const cause = clipped
          ? `the marker was clipped to ${String(detection.extent.width)}x${String(detection.extent.height)} px instead of the ${String(drawnExtent)}x${String(drawnExtent)} px drawn, so its measured centre is not the point it was drawn at. `
            + 'Move the target away from the screen edge — or from whatever is covering it — and run the round again.'
          : `the marker could not be placed on the target within ${String(tolerance)} px.`
        throw new Error(
          `${lines.join('\n')}\n\nVERIFICATION FAILED: ${cause} `
          + 'No click is permitted. Re-read the compressed image, report the coordinate again through screen_ask_ai, and re-run screen_map_to_screen.',
        )
      }

      round_.verified = {
        screenX: args.screen_x,
        screenY: args.screen_y,
        imageX,
        imageY,
        target: args.target ?? null,
        tolerance,
        delta,
        markerPixels: detection.pixels,
        markerPath: path,
        viewPath,
        viewScale: viewPlan.ratio * desktopToImage,
      }
      round_.verifiedAt = Date.now()
      round_.fingerprint = fingerprint
      store.note(round_, `verified (${args.screen_x}, ${args.screen_y}) delta (${String(delta.x)}, ${String(delta.y)})`)

      const viewScale = round_.verified.viewScale
      lines.push(
        '',
        'VERIFIED. Confirm in the image above that the red crosshair sits on the intended element:',
        `- it marks desktop (${String(args.screen_x)}, ${String(args.screen_y)}), which is where the click will land;`,
        `- the inspection view is ${String(viewPlan.width)}x${String(viewPlan.height)} px at ${String(round(viewScale, 4))} view px per desktop px, so the same point is at view pixel (${String(round((args.screen_x - region.x) * viewScale, 1))}, ${String(round((args.screen_y - region.y) * viewScale, 1))}).`,
        'If it is not on the target, do NOT proceed: re-read the image and repeat screen_ask_ai -> screen_map_to_screen -> screen_mark_verify.',
        'Otherwise call screen_do now. The verification expires quickly and the click is refused if the screen under the target changed.',
      )

      const blocks = await offerImage(delivery, exec, viewBuffer, viewPath, inline)
      return lines.join('\n') + blocks.map((block) => `\n${block.text}`).join('')
    },
  }

  // ── 7. simulate_input ─────────────────────────────────────────────────────

  const simulateInput = {
    name: 'screen_do',
    description: [
      'Deliver input to the real desktop: click, double_click, right_click, drag, scroll, key_type, key_press.',
      'Refuses to run without a fresh verification from screen_mark_verify, re-checks the screen fingerprint under the target immediately before acting, moves the cursor to the verified pixel and reads the cursor position back before pressing, and settles for 150-300 ms before and after.',
      'For click, double_click, right_click, and drag the coordinates are taken from the verification — not from the arguments — so the point that was verified is the point that is clicked. Use dry_run to rehearse the whole path with every check and no input (a dry run delivers nothing, so it is not recorded as unconfirmed).',
      'A real action is then recorded as unconfirmed until a FULL-screen screen_capture has looked at the screen again: the reaction reported here is measured at one point and is not an answer to what the screen now shows, and a zoomed frame is not that look either. screen_cleanup_round refuses to close a round while the confirmation is missing.',
    ].join(' '),
    parameters: {
      action: { type: 'string', required: true, description: 'click | double_click | right_click | drag | scroll | key_type | key_press' },
      screen_x: { type: 'number', description: 'Target x. Required for drag start; ignored for click/double_click/right_click, which use the verified point.' },
      screen_y: { type: 'number', description: 'Target y. Required for drag start.' },
      to_x: { type: 'number', description: 'Drag end x, as a real desktop coordinate. Required for drag.' },
      to_y: { type: 'number', description: 'Drag end y. Required for drag.' },
      text: { type: 'string', description: 'Text for key_type. Delivered as Unicode characters, not as layout-dependent keystrokes.' },
      keys: { type: 'string', description: 'For key_press: a key or chord such as "enter", "esc", "ctrl+c", "alt+tab", "f5".' },
      amount: { type: 'number', description: 'Scroll notches. Positive scrolls up/right, negative down/left. Defaults to 3.' },
      horizontal: { type: 'boolean', description: 'For scroll: use the horizontal wheel instead of the vertical one.' },
      dry_run: { type: 'boolean', description: 'Run every check and report the outcome without delivering any input.' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => text(value) },
    async execute(args) {
      const action = String(args.action ?? '').trim().toLowerCase()
      const known = ['click', 'double_click', 'right_click', 'drag', 'scroll', 'key_type', 'key_press']
      if (!known.includes(action)) {
        throw new Error(`screen-control: unknown action "${String(args.action)}". Supported: ${known.join(', ')}.`)
      }
      const dryRun = args.dry_run === true
      const settle = async (ms) => await new Promise((resolve) => setTimeout(resolve, ms))

      // ── keyboard actions: no cursor, so no coordinate to verify ─────────
      //
      // The verify-then-click gate exists because a POINTER action is delivered
      // to a coordinate, and a stale coordinate is a misclick. A keystroke is
      // delivered to whatever holds focus, so there is no coordinate to be
      // wrong about and requiring one would only force a pointless round — or,
      // for the common first step of focusing a window with alt+tab, make the
      // step impossible to take at all. The check that does apply is which
      // window holds focus, and that is reported before the keys are sent.
      if (action === 'key_type' || action === 'key_press') {
        const round_ = store.require(sessionId)
        const focus = win.foregroundWindow()
        const lines = [
          `${action} (no coordinate needed; keystrokes go to the focused window)`,
          `foreground window: ${win.describeWindowLine(focus)}`,
        ]
        if (dryRun) {
          lines.push('dry run: no input delivered')
          return lines.join('\n')
        }
        if (action === 'key_type') {
          const value = typeof args.text === 'string' ? args.text : ''
          if (value === '') throw new Error('screen-control: key_type needs non-empty text')
          await settle(200)
          const sent = win.typeUnicode(value)
          await settle(250)
          lines.push(`typed ${String([...value].length)} characters as ${String(sent)} synthesized events`)
        } else {
          const spec = typeof args.keys === 'string' ? args.keys.trim() : ''
          if (spec === '') throw new Error('screen-control: key_press needs keys, for example "enter" or "ctrl+c"')
          const parts = spec.split('+').map((part) => part.trim().toLowerCase()).filter((part) => part !== '')
          const codes = []
          for (const part of parts) {
            const code = VIRTUAL_KEYS[part]
            if (code === undefined) {
              throw new Error(`screen-control: unknown key "${part}". Known names include enter, esc, tab, space, delete, home, end, pageup, pagedown, arrows, f1-f15, a-z, 0-9, ctrl, shift, alt.`)
            }
            codes.push(code)
          }
          await settle(200)
          for (const code of codes) win.keyDown(code)
          await settle(40)
          for (const code of [...codes].reverse()) win.keyUp(code)
          await settle(250)
          lines.push(`pressed ${parts.join('+')} (${codes.map((code) => `0x${code.toString(16)}`).join(', ')})`)
        }
        const after = win.foregroundWindow()
        // The keys have gone out, so the screen now holds the result of this
        // input and nobody has looked at it yet.
        store.recordInput(sessionId, { round: round_.round, action, at: new Date().toISOString(), screenX: null, screenY: null })
        lines.push(
          `foreground window now: ${after === null ? 'unknown' : `${after.title === '' ? '(untitled)' : after.title} [${after.className}]`}${focus !== null && after !== null && focus.handle !== after.handle ? ' (changed)' : ''}`,
          '',
          'REQUIRED NEXT STEP: screen_capture for the FULL screen. The keystrokes above just changed something and you have not seen the result; a zoomed frame cannot stand in for this look. Read the captured frame and state the final state of the screen.',
          'Then screen_cleanup_round — it refuses to close this round until that capture has been taken.',
        )
        return lines.join('\n')
      }

      const round_ = store.requireVerified(sessionId)
      const meta = round_.meta

      // ── pointer actions all start from the verified point ───────────────
      const x = round_.verified.screenX
      const y = round_.verified.screenY
      const problems = validateTarget(x, y, meta, meta.minTargetMargin)
      if (problems.length > 0) throw new Error(`screen-control: refusing input:\n- ${problems.join('\n- ')}`)

      const ageMs = Date.now() - round_.verifiedAt
      if (ageMs > (Number.isFinite(options.verificationTtlMs) ? options.verificationTtlMs : 120000)) {
        round_.verified = null
        round_.verifiedAt = null
        throw new Error(
          `screen-control: the verification for round ${String(round_.round)} is ${String(Math.round(ageMs / 1000))} s old and has expired. `
          + 'The screen may have changed; re-run screen_capture for a fresh round rather than clicking on stale evidence.',
        )
      }

      // Fingerprint the live screen under the target again: if the content
      // moved since verification, the verified point is no longer the target.
      const before = win.foregroundWindow()
      const liveFingerprint = win.patchFingerprint(x, y)
      const drift = win.fingerprintDistance(round_.fingerprint, liveFingerprint)
      const hitWindow = win.windowAt(x, y)

      const header = [
        `round ${String(round_.round)}: ${action} at desktop (${String(x)}, ${String(y)})${round_.verified.target === null ? '' : ` — "${round_.verified.target}"`}`,
        `verified ${String(Math.round(ageMs / 1000))} s ago${ageMs > 30000 ? ' (re-verify if the screen may have changed)' : ''}`,
        `live-screen drift under the target: ${String(drift)} (budget ${String(store.driftThreshold)})`,
        `foreground window: ${win.describeWindowLine(before)}`,
        `window at that point: ${win.describeWindowLine(hitWindow)}`,
      ]

      if (drift > store.driftThreshold) {
        round_.verified = null
        round_.verifiedAt = null
        throw new Error(
          `${header.join('\n')}\n\nREFUSED: the screen under the target changed since verification, so the verified point is no longer `
          + 'provably on the intended element. Nothing was clicked. Re-run screen_capture and re-verify the target.',
        )
      }

      if (dryRun) {
        const probe = win.moveCursorAbsolute(x, y)
        // A rehearsal must cost what the real thing costs, or it would be a way
        // to keep a verification alive and click later on stale evidence.
        round_.verified = null
        round_.verifiedAt = null
        header.push(
          `dry run: cursor moved to (${String(probe.actual.x)}, ${String(probe.actual.y)}), exact=${String(probe.exact)}; no button or key input delivered`,
          'this verification is now consumed, exactly as a real action would consume it. Re-run the round to act for real.',
        )
        return header.join('\n')
      }

      await settle(action === 'drag' ? 150 : 200)

      const results = []
      if (action === 'click' || action === 'double_click' || action === 'right_click') {
        const right = action === 'right_click'
        const move = win.moveCursorAbsolute(x, y)
        results.push(`cursor: requested (${String(move.requested.x)}, ${String(move.requested.y)}), actual (${String(move.actual.x)}, ${String(move.actual.y)}), exact=${String(move.exact)}${move.corrected ? ' (corrected via SetCursorPos)' : ''}`)
        if (!move.exact) {
          throw new Error(
            `${header.join('\n')}\n${results.join('\n')}\n\nREFUSED: the cursor did not land on the verified pixel, so the click would land `
            + 'somewhere else. Nothing was clicked. Re-run screen_mark_verify, then retry.',
          )
        }
        // The window under the cursor is re-tested after the move, so the click
        // is attributed to what is actually there now.
        const under = win.windowAt(move.actual.x, move.actual.y)
        results.push(`window under cursor after the move: ${win.describeWindowLine(under)}`)

        // Place the cursor back on the target before pressing, so every button
        // edge is delivered to the same pixel.
        const recheck = win.cursorPosition()
        if (recheck.x !== x || recheck.y !== y) {
          win.setCursorPosition(x, y)
          const again = win.cursorPosition()
          results.push(`cursor re-pinned to (${String(again.x)}, ${String(again.y)})`)
          if (again.x !== x || again.y !== y) {
            throw new Error(`${header.join('\n')}\n${results.join('\n')}\n\nREFUSED: the cursor would not stay on the verified pixel. Nothing was clicked.`)
          }
        }

        const clicks = action === 'double_click' ? 2 : 1
        for (let i = 0; i < clicks; i++) {
          win.buttonDown(right)
          await settle(30)
          win.buttonUp(right)
          if (i + 1 < clicks) await settle(60)
          results.push(`press ${String(i + 1)} of ${String(clicks)}: ${right ? 'right' : 'left'} button down and up`)
        }

        // Close the loop: measure where the interface reacted. A click that
        // misses produces no change at the target, so the round reports that
        // instead of letting the agent assume success.
        await settle(320)
        const atTarget = win.patchFingerprint(x, y)
        const local = win.fingerprintDistance(round_.fingerprint, atTarget)
        const ring = []
        const radius = Number.isFinite(options.verifyRadius) ? options.verifyRadius : 64
        for (const [dx, dy] of [[radius, 0], [-radius, 0], [0, radius], [0, -radius], [radius, radius], [-radius, -radius]]) {
          const px = Math.min(Math.max(x + dx, meta.originX + 2), meta.originX + meta.imageWidth / meta.ratio - 3)
          const py = Math.min(Math.max(y + dy, meta.originY + 2), meta.originY + meta.imageHeight / meta.ratio - 3)
          ring.push({ dx, dy, drift: win.fingerprintDistance(round_.fingerprint, win.patchFingerprint(px, py)) })
        }
        const surroundings = ring.map((entry) => entry.drift)
        const maxSurrounding = Math.max(...surroundings)
        const meanSurrounding = round(surroundings.reduce((sum, value) => sum + value, 0) / surroundings.length, 2)

        results.push(
          `interface reaction: ${String(local)} luma drift at the target (${String(radius)} px ring: mean ${String(meanSurrounding)}, max ${String(round(maxSurrounding, 2))})`,
          local >= 2
            ? 'the interface changed at the clicked point: the click had an effect where it was aimed.'
            : maxSurrounding >= 2
              ? 'NOTHING CHANGED AT THE TARGET, but the surroundings moved. Treat this click as having missed or been ignored: re-capture and re-verify before continuing.'
              : 'nothing on screen changed yet. The control may be unresponsive, may need a moment, or the click may not have registered — verify with screen_capture before assuming it worked.',
        )
        await settle(250)
      } else if (action === 'drag') {
        const toX = Number.isFinite(args.to_x) ? args.to_x : x
        const toY = Number.isFinite(args.to_y) ? args.to_y : y
        if (!Number.isFinite(args.to_x) || !Number.isFinite(args.to_y)) {
          throw new Error('screen-control: drag needs both to_x and to_y as real desktop coordinates')
        }
        const endProblems = validateTarget(toX, toY, meta, meta.minTargetMargin)
        if (endProblems.length > 0) throw new Error(`screen-control: refusing drag destination:\n- ${endProblems.join('\n- ')}`)

        const move = win.moveCursorAbsolute(x, y)
        if (!move.exact) throw new Error(`${header.join('\n')}\nREFUSED: the cursor did not land on the drag origin. Nothing was dragged.`)
        results.push(`cursor at origin: (${String(move.actual.x)}, ${String(move.actual.y)}) exact=${String(move.exact)}`)
        win.buttonDown(false)
        results.push('left button down')
        await settle(150)
        const steps = 14
        for (let i = 1; i <= steps; i++) {
          const px = Math.round(x + ((toX - x) * i) / steps)
          const py = Math.round(y + ((toY - y) * i) / steps)
          win.setCursorPosition(px, py)
          await settle(18)
        }
        const landed = win.cursorPosition()
        results.push(`moved to (${String(landed.x)}, ${String(landed.y)}) in ${String(steps)} steps`)
        win.buttonUp(false)
        results.push('left button up')
        await settle(250)
      } else if (action === 'scroll') {
        const notches = Number.isFinite(args.amount) ? args.amount : 3
        const move = win.moveCursorAbsolute(x, y)
        results.push(`cursor: actual (${String(move.actual.x)}, ${String(move.actual.y)}) exact=${String(move.exact)}`)
        if (!move.exact) throw new Error(`${header.join('\n')}\nREFUSED: the cursor did not land on the verified pixel. Nothing was scrolled.`)
        if (args.horizontal === true) {
          win.wheelHorizontal(notches)
          results.push(`horizontal wheel ${String(notches)} notches`)
        } else {
          win.wheelVertical(notches)
          results.push(`vertical wheel ${String(notches)} notches`)
        }
        await settle(250)
      }

      const after = win.foregroundWindow()
      const cursor = win.cursorPosition()
      // Input has gone out. Whatever it did is on the screen now and has not been
      // looked at, so it is recorded as unconfirmed until a full-screen capture
      // covers it: the reaction measured above is a luma delta at one point, not
      // an answer to "what is the screen showing now".
      store.recordInput(sessionId, { round: round_.round, action, at: new Date().toISOString(), screenX: x, screenY: y })
      const lines = [
        ...header,
        ...results,
        `cursor now: (${String(cursor.x)}, ${String(cursor.y)})`,
        `foreground window after: ${after === null ? 'unknown' : `${after.title === '' ? '(untitled)' : after.title} [${after.className}]`}${before !== null && after !== null && before.handle !== after.handle ? ' (changed)' : ''}`,
        `ripples: ${String(round_.verified.markerPath)}`,
        '',
        'This round has consumed its verification.',
        'REQUIRED NEXT STEP: screen_capture for the FULL screen — the input above just changed something, and that frame is the only evidence of what it did. A zoomed frame does not count: it magnifies one rectangle and cannot tell you the state of the screen.',
        'screen_cleanup_round refuses to close this round until that capture has been taken. To act again afterwards, capture a new round and run:',
        'screen_capture -> screen_overlay_grid -> screen_compress -> screen_ask_ai -> screen_map_to_screen -> screen_mark_verify -> screen_do.',
      ]
      return lines.join('\n')
    },
  }

  // ── 8. cleanup_round ──────────────────────────────────────────────────────

  const cleanupRound = {
    name: 'screen_cleanup_round',
    description: [
      'Delete the images a round produced — the full capture, the grid image, the compressed image, the marker image, and the inspection view — then re-read the directory and force a second removal, so a round cannot end with a screenshot on disk.',
      'Cleans the CURRENT round by default, which is the scope you want while working: capturing twice to compare two moments must not have the second cleanup destroy the first frame. Pass round_id to clean one earlier round by number.',
      'Pass all_rounds to sweep EVERY image in the screenshots directory regardless of which round wrote it — that is the end-of-task sweep, and the only thing that clears an image an interrupted run left untracked. The result always reports the scope it covered and what remains.',
      'It also refuses to close a round over input that was delivered and never looked at afterwards: the outcome of a click is not contained in the click, so a FULL-screen screen_capture has to happen first, and a zoomed frame does not count. Pass skip_confirmation only to abandon a target, and the result records that the final state was not verified.',
    ].join(' '),
    parameters: {
      round_id: { type: 'number', description: 'Clean this round number instead of the current round.' },
      all_rounds: { type: 'boolean', description: 'Also clean every earlier round this session produced.' },
      verify_only: { type: 'boolean', description: 'Report what would be removed without removing anything.' },
      skip_confirmation: { type: 'boolean', description: 'Close even though input was delivered and never looked at on a full-screen capture. Only for an abandoned target, and the cleanup result records that the final state was not verified.' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => text(value) },
    async execute(args) {
      const before = await store.inventory()
      if (args.verify_only === true) {
        return [
          `directory: ${before.directory}`,
          `images present: ${String(before.images.length)}`,
          ...before.images.map((image) => `- ${image.name} (${String(image.bytes)} bytes)`),
          before.stray.length === 0 ? 'non-image entries: none' : `non-image entries: ${before.stray.map((entry) => `${entry.name} (${entry.kind})`).join(', ')}`,
          before.images.length === 0 ? 'clean already' : 'call screen_cleanup_round to remove them',
        ].join('\n')
      }

      // An input's result is not knowable from the input. Refusing here is what
      // makes "capture the full screen after you click" a property of the tool
      // rather than advice: a round whose input was never looked at cannot be
      // closed, and a zoomed frame is not a look at it.
      const unconfirmed = store.pendingInputs(sessionId)
      const skipConfirmation = args.skip_confirmation === true
      if (unconfirmed.length > 0 && !skipConfirmation) {
        throw new Error(
          [
            'REFUSED to close this round: input was delivered and nothing has captured the screen since, so how it turned out has not been looked at. A click reports where the pointer went, never what the machine did with it.',
            ...unconfirmed.map((entry) => `- round ${String(entry.round)}: ${entry.action}${entry.screenX === null || entry.screenX === undefined ? ' (delivered to the focused window)' : ` at desktop (${String(entry.screenX)}, ${String(entry.screenY)})`} at ${entry.at}`),
            '',
            'Call screen_capture for the FULL screen, read that frame, and state what the screen now shows. A zoomed frame does not settle this: it magnifies one rectangle and covers nothing else, so it can never stand for the state of the screen.',
            'If this target is being abandoned rather than confirmed, pass skip_confirmation: true — and say in your report that the final state was not verified.',
          ].join('\n'),
        )
      }

      const requested = Number.isFinite(args.round_id) ? Math.round(args.round_id) : null

      // `all_rounds` is the end-of-task sweep, so it means the whole directory:
      // every image this plugin wrote belongs to some round, and an image that
      // a crash or an interrupted run left untracked is exactly what a sweep
      // must not miss. It is also the only useful request when no round is
      // open, which is the normal state after finishing — refusing it there
      // would leave residue with no way to clear it.
      if (requested === null && args.all_rounds === true) {
        const own = store.currentRound(sessionId)
        const swept = await store.cleanup({ round: own === null ? 0 : own.round, sessionId, files: own === null ? [] : own.files }, { wholeDirectory: true })
        const remaining = await store.inventory()
        const lines = [
          `cleaned scope: ${swept.scope}`,
          `directory: ${swept.directory}`,
          `files removed: ${String(swept.removed.length)}`,
          ...swept.removed.map((path) => `- ${path}`),
        ]
        if (swept.failed.length > 0) lines.push(`FAILED to remove: ${swept.failed.map((entry) => `${entry.path} (${entry.error})`).join(', ')}`)
        lines.push('', `images remaining in ${remaining.directory}: ${String(remaining.images.length)}`)
        if (remaining.images.length === 0) lines.push('no image remains: the directory holds nothing this plugin wrote')
        else lines.push(`RESIDUE: ${remaining.images.map((image) => image.name).join(', ')}`)
        if (!swept.clean) throw new Error(`${lines.join('\n')}\n\nCLEANUP FAILED: ${String(swept.failed.length)} file(s) could not be removed.`)
        if (skipConfirmation && unconfirmed.length > 0) lines.push('', `closed WITHOUT confirmation: ${String(unconfirmed.length)} delivered input(s) were never looked at on a full-screen capture, so the final state of the screen was not verified.`)
        store.clearInputLedger(sessionId)
        lines.push('', 'Start a new round with screen_capture when you have the next target.')
        return lines.join('\n')
      }

      const target = requested === null ? store.currentRound(sessionId) : store.roundFiles(requested)
      if (target === null) {
        const known = store.knownRounds()
        throw new Error(
          requested === null
            ? 'screen-control: no round is open, so there is nothing scoped to clean. Pass all_rounds to sweep every image in the directory.'
            : `screen-control: round ${String(requested)} is not tracked by this session, so its files cannot be identified. Rounds still nameable: ${known.length === 0 ? 'none' : known.join(', ')}. Pass all_rounds to sweep the directory instead.`,
        )
      }

      const result = await store.cleanup(target, { allRounds: args.all_rounds === true })
      const after = await store.inventory()
      const lines = [
        `cleaned scope: ${result.scope} (round ${String(target.round)}${args.all_rounds === true ? ' and all earlier rounds' : ''})`,
        `directory: ${result.directory}`,
        `files removed: ${String(result.removed.length)}`,
        ...result.removed.map((path) => `- ${path}`),
      ]
      if (result.failed.length > 0) lines.push(`FAILED to remove: ${result.failed.map((entry) => `${entry.path} (${entry.error})`).join(', ')}`)
      lines.push('', `images remaining in ${after.directory}: ${String(after.images.length)}`)
      if (after.images.length > 0) {
        lines.push(`still present: ${after.images.map((image) => image.name).join(', ')}`)
        lines.push(result.scope === 'whole-directory'
          ? 'RESIDUE: the whole directory was swept and these survived.'
          : 'These belong outside the cleaned scope. Pass all_rounds to remove them too.')
      } else {
        lines.push('no image remains: the cleaned scope left nothing behind')
      }
      if (!result.clean) {
        throw new Error(`${lines.join('\n')}\n\nCLEANUP FAILED: ${String(result.failed.length)} file(s) could not be removed.`)
      }
      if (skipConfirmation && unconfirmed.length > 0) lines.push('', `closed WITHOUT confirmation: ${String(unconfirmed.length)} delivered input(s) were never looked at on a full-screen capture, so the final state of the screen was not verified.`)
      store.clearInputLedger(sessionId)
      lines.push('', 'Start a new round with screen_capture when you have the next target.')
      return lines.join('\n')
    },
  }

  return [captureFullscreen, overlayGrid, zoom, probe, compress, askAi, mapToScreen, markAndVerify, simulateInput, cleanupRound]
}
