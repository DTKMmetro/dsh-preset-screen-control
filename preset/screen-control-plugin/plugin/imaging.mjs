/**
 * The image half of one screen-control round.
 *
 * Every function here works on the physical pixels the capture produced, and
 * every coordinate it prints is a real desktop coordinate. The compression
 * ratio is the single number that connects the two spaces, so it is threaded
 * through as `ratio` and never recomputed from a rounded width — a 0.4%
 * rounding error is 5 px at the far edge of a 1280-wide image, which is
 * already a different button.
 *
 * @module screen-control/imaging
 */

import { loadDependency } from './deps.mjs'

/** Grid and text colours, chosen for contrast against arbitrary desktops. */
export const GRID_COLOR = '#ff2d95'
export const REFERENCE_COLOR = '#00e5ff'
export const MARK_COLOR = '#ff0000'
export const REPORT_COLOR = '#ffe100'

/** Adaptive grid spacing (logical px) and compression cap, per the preset spec. */
export function gridSpacing(logicalShortEdge) {
  return logicalShortEdge < 1080 ? 50 : 100
}

export function maxEdgeFor(logicalLongEdge) {
  return logicalLongEdge > 1920 ? 1280 : 1600
}

/**
 * The effective image-pixels-per-desktop-pixel factor of a frame.
 *
 * This is the one number that connects what the model sees to the desktop:
 *
 *     screen = origin + image / scale
 *
 * It is `meta.ratio` (the current compression ratio) multiplied by
 * `meta.zoom` (the magnification the frame was captured at). Expressing it as
 * one factor rather than two is what lets a zoom survive a later compression
 * instead of being silently cancelled by it.
 */
export function frameScale(meta) {
  const zoom = meta.zoom === undefined || meta.zoom === null ? 1 : meta.zoom
  return meta.ratio * zoom
}

/** The desktop rectangle a frame covers. */
export function frameRegion(meta) {
  const scale = frameScale(meta)
  return {
    x: meta.originX,
    y: meta.originY,
    width: meta.imageWidth / scale,
    height: meta.imageHeight / scale,
  }
}

/**
 * Plan a compression for the current frame.
 *
 * `maxEdge` bounds the long edge of the IMAGE. When the source is already
 * within that bound the plan is the identity — `ratio` 1 — which is what keeps
 * a magnified frame magnified: a 4x view of a 512 px strip is 2048 px wide and
 * must not be shrunk back to 1280, because that would throw away exactly the
 * detail the zoom was taken to obtain.
 */
export function planCompression(width, height, maxEdge) {
  const longEdge = Math.max(width, height)
  const ratio = longEdge <= maxEdge ? 1 : maxEdge / longEdge
  return {
    ratio,
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
    scaled: ratio < 1,
  }
}

export async function loadSharp(bases) {
  return await loadDependency('sharp', bases)
}

/** Encode a raw RGBA raster as PNG. */
export async function encodePng(sharp, raster) {
  return await sharp(raster.data, {
    raw: { width: raster.width, height: raster.height, channels: raster.channels },
  }).png({ compressionLevel: 6 }).toBuffer()
}

/**
 * Build the grid overlay as SVG at the current frame's size.
 *
 * A line at image coordinate `x` sits at desktop `origin + x / (ratio * zoom)`,
 * so `ratio` (the compression) and `zoom` (the magnification) both participate:
 * a grid cell stays a fixed number of DESKTOP pixels wide no matter how the
 * frame was produced, and every label prints the real desktop coordinate of its
 * line. That is what lets the model report a point straight off the image
 * instead of counting grid lines.
 */
export function buildGridSvg(options) {
  const { originX, originY, width, height, spacing, ratio, scaleFactor, labelPrefix } = options
  const zoom = options.zoom === undefined || options.zoom === null ? 1 : options.zoom
  const scale = ratio * zoom
  const parts = [
    `<rect x="0" y="0" width="${width}" height="${height}" fill="none"/>`,
  ]
  const label = (x, y, text, fill) => `<text x="${x}" y="${y}" font-family="Consolas,monospace" font-size="13" fill="${fill}" stroke="#000000" stroke-width="3" paint-order="stroke">${text}</text>`

  for (let x = 0; x <= width; x += spacing) {
    const real = Math.round(originX + x / scale)
    parts.push(`<line x1="${x}" y1="0" x2="${x}" y2="${height}" stroke="${GRID_COLOR}" stroke-width="1" stroke-opacity="0.7"/>`)
    // Skip the label that would collide with the origin corner block.
    if (x > 0 || true) parts.push(label(x + 3, 15, `x${real}`, GRID_COLOR))
  }
  for (let y = 0; y <= height; y += spacing) {
    const real = Math.round(originY + y / scale)
    parts.push(`<line x1="0" y1="${y}" x2="${width}" y2="${y}" stroke="${GRID_COLOR}" stroke-width="1" stroke-opacity="0.7"/>`)
    if (y > 0) parts.push(label(3, y + 15, `y${real}`, GRID_COLOR))
  }

  parts.push(label(4, height - 8, `${labelPrefix}`, REFERENCE_COLOR))
  parts.push(label(width - 190, 15, `scale x${(1 / ratio).toFixed(4)}`, REFERENCE_COLOR))
  parts.push(label(width - 190, 34, `dpi ${String(scaleFactor)}x`, REFERENCE_COLOR))

  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${parts.join('')}</svg>`)
}

/**
 * Paint a crosshair plus a small filled disc into a raw RGBA raster.
 *
 * The disc is what makes the mark measurable: a ring or long arms are clipped
 * asymmetrically against a screen edge and drag the detected centroid several
 * pixels off centre, which is precisely the error this whole pipeline exists
 * to avoid. The disc stays symmetric until it is more than half clipped, so
 * the centroid it produces stays on the target.
 */
export function paintCrosshair(raster, cx, cy, color, arm, thick) {
  const { data, width, height, channels } = raster
  const red = color[0]
  const green = color[1]
  const blue = color[2]

  const put = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return
    const o = (y * width + x) * channels
    data[o] = red
    data[o + 1] = green
    data[o + 2] = blue
    data[o + 3] = 255
  }

  const half = Math.floor(thick / 2)
  for (let d = -arm; d <= arm; d++) {
    for (let t = -half; t <= half; t++) {
      put(cx + d, cy + t)
      put(cx + t, cy + d)
    }
  }

  const disc = 4
  for (let dy = -disc; dy <= disc; dy++) {
    for (let dx = -disc; dx <= disc; dx++) {
      if (dx * dx + dy * dy <= disc * disc) put(cx + dx, cy + dy)
    }
  }
}

export function hexToRgb(hex) {
  const value = hex.replace('#', '')
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ]
}

/**
 * Recover the centroid and extent of a painted mark inside a search window.
 *
 * `tolerance` is deliberately tight: the mark is rendered by this plugin, so
 * anything beyond a couple of pixels of centroid drift means the geometry that
 * produced it is wrong, and the caller must not click.
 */
export function detectMark(raster, cx, cy, color, window) {
  const { data, width, height, channels } = raster
  const [red, green, blue] = color
  let sumX = 0
  let sumY = 0
  let count = 0
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY

  const fromX = Math.max(0, cx - window)
  const toX = Math.min(width - 1, cx + window)
  const fromY = Math.max(0, cy - window)
  const toY = Math.min(height - 1, cy + window)

  for (let y = fromY; y <= toY; y++) {
    for (let x = fromX; x <= toX; x++) {
      const o = (y * width + x) * channels
      if (
        Math.abs(data[o] - red) <= 60
        && Math.abs(data[o + 1] - green) <= 60
        && Math.abs(data[o + 2] - blue) <= 60
      ) {
        sumX += x
        sumY += y
        count++
        if (x < minX) minX = x
        if (y < minY) minY = y
        if (x > maxX) maxX = x
        if (y > maxY) maxY = y
      }
    }
  }

  if (count === 0) return { detected: false, pixels: 0, centroid: null, extent: null }
  return {
    detected: true,
    pixels: count,
    centroid: { x: sumX / count, y: sumY / count },
    extent: { minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1 },
  }
}

/**
 * Mean absolute per-channel difference between two rasters of equal size.
 *
 * Used to tell "the verification marker is the only change on screen" from
 * "the window moved underneath the marker", which is the difference between a
 * safe click and a blind one.
 */
export function rasterDrift(left, right) {
  if (left.width !== right.width || left.height !== right.height) return Number.POSITIVE_INFINITY
  const a = left.data
  const b = right.data
  let total = 0
  let count = 0
  for (let i = 0; i < a.length; i += 4) {
    total += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])
    count += 3
  }
  return Math.round((total / count) * 1000) / 1000
}

/**
 * Map a frame image coordinate to a real desktop coordinate.
 *
 * `screen = image / scale + origin`, where the scale is the frame's combined
 * compression-times-zoom factor and the origin is the covered rectangle's
 * top-left on the virtual desktop — negative when the virtual desktop starts
 * left of or above the primary display, and the sign is preserved.
 */
export function imageToScreen(gx, gy, meta) {
  const scale = frameScale(meta)
  return {
    x: gx / scale + meta.originX,
    y: gy / scale + meta.originY,
  }
}

/** The inverse, used to report where a real coordinate falls in the image. */
export function screenToImage(screenX, screenY, meta) {
  const scale = frameScale(meta)
  return {
    gx: (screenX - meta.originX) * scale,
    gy: (screenY - meta.originY) * scale,
  }
}

/** Whether a point lies inside the frame's covered rectangle, in real coordinates. */
export function insideRegion(x, y, meta) {
  const region = frameRegion(meta)
  return x >= region.x && y >= region.y
    && x < region.x + region.width
    && y < region.y + region.height
}

/** The largest value in a numeric profile. */
function peakOf(profile) {
  let peak = 0
  for (let i = 0; i < profile.length; i++) if (profile[i] > peak) peak = profile[i]
  return peak
}

/**
 * Split a bright-on-dark band into separate elements by column profile.
 *
 * This is the measurement that replaces guessing. A taskbar, toolbar or icon
 * strip is a row of small marks on a flat background, and after resizing for
 * the model those marks are a few pixels wide — reading their coordinates off
 * the rendered image is where a click goes wrong by hundreds of pixels. The
 * column profile is computed from the native pixels instead, so an element's
 * extent and centre are measured rather than estimated.
 *
 * `axis` is 'x' for a horizontal band of icons (the usual case) or 'y' for a
 * vertical one; the other axis is reported as the full band extent.
 */
export function measureBlobs(raster, options) {
  const { data, width, height, channels } = raster
  const axis = options.axis === 'y' ? 'y' : 'x'
  const threshold = Number.isFinite(options.threshold) ? options.threshold : 70
  const floor = Number.isFinite(options.floor) ? options.floor : 40
  const minWidth = Number.isFinite(options.minWidth) ? options.minWidth : 8

  const span = axis === 'x' ? width : height
  const depth = axis === 'x' ? height : width
  const profile = new Float64Array(span)
  for (let s = 0; s < span; s++) {
    let sum = 0
    for (let d = 0; d < depth; d++) {
      const x = axis === 'x' ? s : d
      const y = axis === 'x' ? d : s
      const o = (y * width + x) * channels
      const luma = (data[o] * 77 + data[o + 1] * 150 + data[o + 2] * 29) >> 8
      if (luma > threshold) sum += luma - threshold
    }
    profile[s] = sum
  }

  const blobs = []
  let start = -1
  for (let s = 0; s <= span; s++) {
    const on = s < span && profile[s] > floor
    if (on && start === -1) start = s
    if (!on && start !== -1) {
      if (s - start >= minWidth) {
        // The band was split along one axis. The OTHER axis must be measured
        // over this element's own pixels rather than assumed to be the band's
        // midpoint: a band drawn generously around a row has slack on that
        // axis, and reporting the slack's centre hands the caller a coordinate
        // that is close enough to hit the element and far enough to be wrong —
        // the worst kind of error, because the click succeeds and the number
        // was never right.
        //
        // Two thresholds, doing two different jobs. A very low one finds where
        // this element starts and ends along the depth axis — it must be low
        // enough to include artwork that is dark (the lower half of a blue-green
        // logo, say) yet still high enough that the gap between the icon and the
        // running-indicator beneath it reads as a gap. A higher one, applied only
        // inside that run, trims rows that are essentially background.
        //
        // A single threshold cannot do both: set it low and the indicator merges
        // into the icon, set it high and the icon's dark half is cut off, which
        // biases the centre toward whichever half is brighter. Growing outward
        // from the single strongest row was tried too and rejected for the same
        // reason — the densest band sits where the artwork is richest, not at its
        // middle, so it produced a consistent directional error.
        let lo = Number.POSITIVE_INFINITY
        let hi = Number.NEGATIVE_INFINITY
        const depthProfile = new Float64Array(depth)
        for (let d = 0; d < depth; d++) {
          let sum = 0
          for (let s2 = start; s2 <= s - 1; s2++) {
            const x = axis === 'x' ? s2 : d
            const y = axis === 'x' ? d : s2
            const o = (y * width + x) * channels
            const luma = (data[o] * 77 + data[o + 1] * 150 + data[o + 2] * 29) >> 8
            if (luma > threshold) sum += luma - threshold
          }
          depthProfile[d] = sum
          if (sum > 1) {
            if (d < lo) lo = d
            if (d > hi) hi = d
          }
        }
        // Largest gap-free stretch of the touched rows is the element's own body.
        let cross = null
        let runStart = -1
        let best = null
        for (let d = 0; d <= depth; d++) {
          const on = d < depth && depthProfile[d] > 1
          if (on && runStart === -1) runStart = d
          if (!on && runStart !== -1) {
            const run = { from: runStart, to: d - 1 }
            if (best === null || run.to - run.from > best.to - best.from) best = run
            runStart = -1
          }
        }
        if (best !== null && best.to > best.from) {
          const hold = Math.max(peakOf(depthProfile.subarray(best.from, best.to + 1)) * 0.05, 1)
          let trimLo = best.from
          let trimHi = best.to
          while (trimLo < trimHi && depthProfile[trimLo] < hold) trimLo++
          while (trimHi > trimLo && depthProfile[trimHi] < hold) trimHi--
          cross = { from: trimLo, to: trimHi, centre: Math.round((trimLo + trimHi) / 2) }
        }
        blobs.push({ from: start, to: s - 1, cross })
      }
      start = -1
    }
  }

  const hueName = (h) => {
    if (h === null) return 'neutral'
    if (h < 15 || h >= 345) return 'red'
    if (h < 45) return 'orange'
    if (h < 70) return 'yellow'
    if (h < 170) return 'green'
    if (h < 200) return 'cyan'
    if (h < 255) return 'blue'
    if (h < 290) return 'violet'
    return 'magenta'
  }

  return blobs.map((blob, index) => {
    // Colour composition of the blob, so an element can be recognised by what
    // it is made of rather than only by where it sits.
    const buckets = new Map()
    let bright = 0
    let sumR = 0
    let sumG = 0
    let sumB = 0
    for (let s = blob.from; s <= blob.to; s++) {
      for (let d = 0; d < depth; d++) {
        const x = axis === 'x' ? s : d
        const y = axis === 'x' ? d : s
        const o = (y * width + x) * channels
        const r = data[o]
        const g = data[o + 1]
        const b = data[o + 2]
        const luma = (r * 77 + g * 150 + b * 29) >> 8
        if (luma <= threshold) continue
        bright++
        sumR += r
        sumG += g
        sumB += b
        const max = Math.max(r, g, b)
        const min = Math.min(r, g, b)
        let key = 'neutral'
        if (max - min >= 25) {
          let h
          if (max === r) h = ((g - b) / (max - min)) % 6
          else if (max === g) h = (b - r) / (max - min) + 2
          else h = (r - g) / (max - min) + 4
          key = hueName(((h * 60) + 360) % 360)
        }
        buckets.set(key, (buckets.get(key) ?? 0) + 1)
      }
    }
    const colours = [...buckets.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 3)
      .map(([name, count]) => ({ name, share: Math.round((100 * count) / Math.max(1, bright)) }))
    const centre = Math.round((blob.from + blob.to) / 2)
    return {
      index: index + 1,
      from: blob.from,
      to: blob.to,
      size: blob.to - blob.from + 1,
      centre,
      // The measured extent and centre on the axis the band was NOT split
      // along, so the caller never has to assume the band's midpoint.
      crossFrom: blob.cross === null ? null : blob.cross.from,
      crossTo: blob.cross === null ? null : blob.cross.to,
      crossCentre: blob.cross === null ? Math.round((depth - 1) / 2) : blob.cross.centre,
      crossMeasured: blob.cross !== null,
      brightPixels: bright,
      averageRgb: bright === 0 ? null : [Math.round(sumR / bright), Math.round(sumG / bright), Math.round(sumB / bright)],
      colours,
    }
  })
}
