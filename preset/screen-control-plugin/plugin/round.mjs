/**
 * Round state: the artifacts, the geometry, and the proof a click needs.
 *
 * A round is one target. It owns the files it produced, the display snapshot
 * they were captured under, and the verification that licensed a click. Both
 * rules the preset states as non-negotiable live here as state rather than as
 * advice: a click cannot be issued without a fresh verification, and the files
 * cannot be left behind.
 *
 * @module screen-control/round
 */

import { mkdir, readdir, unlink, writeFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'])

function pad(value, width) {
  return String(value).padStart(width, '0')
}

/** `r{round}_{stage}_{timestamp}.png`, the preset's required naming rule. */
export function artifactName(round, stage, at) {
  const stamp = `${String(at.getFullYear())}${pad(at.getMonth() + 1, 2)}${pad(at.getDate(), 2)}`
    + `-${pad(at.getHours(), 2)}${pad(at.getMinutes(), 2)}${pad(at.getSeconds(), 2)}`
    + `-${pad(at.getMilliseconds(), 3)}`
  return `r${pad(round, 2)}_${stage}_${stamp}.png`
}

export class RoundStore {
  constructor(options) {
    this.directory = options.screenshotDir
    this.minTargetMargin = options.minTargetMargin
    this.markTolerance = options.markTolerance
    this.driftThreshold = options.driftThreshold
    this.maxRounds = options.maxRounds
    this.counter = 0
    // One open round PER SESSION. A preset is a standing mount shared by every
    // session that names it, so a single `current` pointer makes the newest
    // round belong to whoever opened it last: the other session's compress,
    // mark, click and cleanup would all then land on a stranger's frame. The
    // verification token matters most — it licenses a real click, and it must
    // never be satisfiable by another session's work.
    this.currentBySession = new Map()
    this.history = []
    this.pendingFingerprint = null
    // Input that has been delivered but not yet LOOKED AT, keyed by session.
    //
    // A click is not evidence of its own result. The tools can prove where the
    // input was delivered — verification, drift check, cursor read-back — and
    // none of that says what the interface then did; only a later frame does.
    // So every delivered input is recorded here, and a full-screen capture is
    // the only thing that clears it: a zoom is a magnifying glass aimed at one
    // rectangle, which is the wrong evidence for "what is the screen showing
    // now". Cleanup refuses to close a round over unconfirmed input, so the
    // final state cannot be assumed away.
    this.pendingInputsBySession = new Map()
    // Set by the plugin once the native layer is bound. A function rather than
    // a value so each call reads the display as it is now.
    this.geometryProver = null
  }

  async ensureDirectory() {
    await mkdir(this.directory, { recursive: true })
    return this.directory
  }

  /** The round this session currently has open, or null. */
  currentRound(sessionId) {
    return this.currentBySession.get(sessionId) ?? null
  }

  /** Open a round, closing any previous one this session left unfinished. */
  begin(capture, sessionId) {
    // A superseded round's file list is recorded HERE, not only when it is
    // cleaned. Otherwise its paths are dropped the moment the next round
    // starts, and `round_id` could only ever address rounds that were already
    // cleaned — which is to say, it could not address anything the caller still
    // needs. Its verification dies now, but its evidence stays nameable.
    const previous = this.currentBySession.get(sessionId) ?? null
    const abandoned = previous === null
      ? null
      : { round: previous.round, files: previous.files.map((file) => file.path), verified: previous.verified }
    if (abandoned !== null) {
      this.history.push({ round: abandoned.round, files: abandoned.files, removed: 0, closedBy: 'superseded', at: new Date().toISOString() })
    }

    this.counter += 1
    const round = {
      round: this.counter,
      sessionId,
      openedAt: new Date().toISOString(),
      capture,
      meta: null,
      view: null,
      grid: null,
      compressed: null,
      zoom: null,
      locatedTarget: null,
      locatedAt: null,
      verified: null,
      verifiedAt: null,
      fingerprint: null,
      files: [],
      events: [],
    }
    this.currentBySession.set(sessionId, round)
    this.pendingFingerprint = null
    return { round, abandoned }
  }

  /**
   * Adopt a new working frame and re-derive the geometry from it.
   *
   * The frame is the single source of truth for what the model is currently
   * looking at. Deriving `meta.originX/Y`, `meta.ratio`, `meta.zoom` and the
   * image dimensions here — rather than mutating them at each call site — is
   * what keeps a zoom from being silently cancelled by a later compression:
   * every consumer reads one consistent set of numbers.
   */
  setFrame(round, frame) {
    round.view = {
      originX: frame.originX,
      originY: frame.originY,
      ratio: frame.ratio,
      zoom: frame.zoom === undefined || frame.zoom === null ? 1 : frame.zoom,
      imageWidth: frame.imageWidth,
      imageHeight: frame.imageHeight,
    }
    round.meta.originX = round.view.originX
    round.meta.originY = round.view.originY
    round.meta.ratio = round.view.ratio
    round.meta.zoom = round.view.zoom
    round.meta.imageWidth = round.view.imageWidth
    round.meta.imageHeight = round.view.imageHeight
    // Changing the frame invalidates any target and verification taken against
    // the previous one.
    round.locatedTarget = null
    round.locatedAt = null
    round.verified = null
    round.verifiedAt = null
    return round.view
  }

  /** The frame's combined image-pixels-per-desktop-pixel factor. */
  frameScale(round) {
    if (round === null || round.view === null) return 1
    return round.view.ratio * round.view.zoom
  }

  /**
   * Refuse to keep working when the display geometry moved under the round.
   *
   * Every coordinate in a round is computed against the geometry captured at
   * its start, and nothing downstream can tell that the geometry changed: the
   * marker is drawn on whatever the screen now returns, measured on that same
   * bitmap, and therefore verifies itself perfectly at a point that no longer
   * means what it meant. A capture region larger than the new screen makes it
   * worse rather than better — BitBlt fills the out-of-bounds part with black,
   * so two such frames fingerprint identically and the drift check reports a
   * stable screen.
   *
   * A content check cannot catch this, because the content is not what moved.
   * The geometry is, so the geometry is what is compared. Callers pass a fresh
   * snapshot; a difference stops the round and asks for a new capture.
   */
  assertGeometryUnchanged(round, live) {
    const captured = round.meta === null || round.meta === undefined ? null : round.meta.geometry
    if (captured === null || captured === undefined) return
    const same = captured.virtual.x === live.virtual.x
      && captured.virtual.y === live.virtual.y
      && captured.virtual.width === live.virtual.width
      && captured.virtual.height === live.virtual.height
      && captured.dpi === live.dpi
      && captured.monitorCount === live.monitorCount
    if (same) return
    const before = `${String(captured.virtual.width)}x${String(captured.virtual.height)} at (${String(captured.virtual.x)}, ${String(captured.virtual.y)}), ${String(captured.dpi)} dpi, ${String(captured.monitorCount)} monitor(s)`
    const now = `${String(live.virtual.width)}x${String(live.virtual.height)} at (${String(live.virtual.x)}, ${String(live.virtual.y)}), ${String(live.dpi)} dpi, ${String(live.monitorCount)} monitor(s)`
    throw new Error(
      `screen-control: the display geometry changed since round ${String(round.round)} captured its frame — was ${before}, now ${now}. `
      + 'Every coordinate in this round was computed against the old geometry, so acting on it would deliver input to a point that no longer means '
      + 'the same thing. Nothing was sent. Run screen_capture to open a round against the new geometry.',
    )
  }

  /**
   * This session's open round, or a message explaining that it has none.
   *
   * Every round-scoped capability resolves its round here, so this is also
   * where the geometry is re-checked: a round whose display has changed since
   * it was captured cannot be trusted for any coordinate, and refusing at the
   * single choke point covers every caller including future ones.
   */
  require(sessionId) {
    const round = this.currentRound(sessionId)
    if (round === null) {
      throw new Error('screen-control: no round is open for this session. Call screen_capture first — every other capability is scoped to the round it belongs to.')
    }
    if (this.geometryProver !== null) this.assertGeometryUnchanged(round, this.geometryProver())
    return round
  }

  requireVerified(sessionId) {
    const round = this.require(sessionId)
    if (round.verified === null || round.verifiedAt === null) {
      throw new Error(
        `screen-control: round ${String(round.round)} has no completed verification. screen_mark_verify must confirm the target `
        + 'immediately before input is simulated; the click is refused otherwise.',
      )
    }
    return round
  }

  note(round, message) {
    round.events.push({ at: new Date().toISOString(), message })
  }

  /**
   * Record input that was delivered and whose result nobody has seen yet.
   *
   * Called only after input has actually gone out — never for a dry run — so
   * the ledger means exactly what it says: something on this machine has
   * changed because of this agent, and the change has not been looked at.
   */
  recordInput(sessionId, entry) {
    const pending = this.pendingInputsBySession.get(sessionId) ?? []
    pending.push(entry)
    this.pendingInputsBySession.set(sessionId, pending)
    return pending.length
  }

  /** Input this session delivered that no full-screen capture has covered. */
  pendingInputs(sessionId) {
    return [...(this.pendingInputsBySession.get(sessionId) ?? [])]
  }

  /**
   * A full-screen capture was taken, and it is the frame that shows what the
   * delivered input actually did. Returns what it covered, so the capture can
   * say so instead of leaving the reader to notice.
   */
  confirmInputs(sessionId) {
    const pending = this.pendingInputsBySession.get(sessionId) ?? []
    if (pending.length === 0) return []
    this.pendingInputsBySession.delete(sessionId)
    return pending
  }

  /** Forget a session's ledger, once its rounds are gone. */
  clearInputLedger(sessionId) {
    this.pendingInputsBySession.delete(sessionId)
  }

  async writeFile(round, stage, buffer) {
    const path = join(this.directory, artifactName(round.round, stage, new Date()))
    await writeFile(path, buffer)
    round.files.push({ stage, path, bytes: buffer.length })
    return path
  }

  /**
   * Delete a round's images, then re-read the directory and force a second
   * removal of anything left. A file that survives deletion is reported as a
   * failure rather than being silently forgotten, because "no screenshots left
   * anywhere" is the point of the cleanup step.
   *
   * Scope is explicit and narrow by default. A round's images are its own, so
   * cleaning round N must not touch round M's: wiping the directory on every
   * call makes "keep two frames to compare, then clean up" impossible, and a
   * cleanup that quietly destroys evidence the caller still needs is worse than
   * one that leaves a file behind. The two wider scopes are therefore opt-in,
   * and each one reports what it covered rather than claiming the whole
   * directory either way.
   *
   * @param round - the round whose files are being cleaned.
   * @param options.allRounds - also clean every earlier round tracked here.
   * @param options.wholeDirectory - clean every image in the directory, even
   *   ones this store never wrote.
   */
  async cleanup(round, options = {}) {
    const allRounds = options.allRounds === true
    const wholeDirectory = options.wholeDirectory === true

    const removed = []
    const failed = []
    const scopedDirectories = new Set()

    const targets = new Set(round.files.map((file) => file.path))
    if (allRounds) {
      for (const entry of this.history) {
        for (const path of entry.files) targets.add(path)
      }
    }

    const sweep = async (path) => {
      scopedDirectories.add(dirname(path))
      try {
        await unlink(path)
        removed.push(path)
      } catch (error) {
        if (error.code === 'ENOENT') removed.push(path)
        else failed.push({ path, error: error.message })
      }
    }

    for (const path of targets) await sweep(path)

    if (wholeDirectory) {
      scopedDirectories.add(this.directory)
      for (const entry of await readdir(this.directory).catch(() => [])) {
        const dot = entry.lastIndexOf('.')
        const extension = dot === -1 ? '' : entry.slice(dot).toLowerCase()
        if (IMAGE_EXTENSIONS.has(extension)) await sweep(join(this.directory, entry))
      }
    }

    // Whatever the scope, a second pass removes anything the first missed.
    for (const entry of await readdir(this.directory).catch(() => [])) {
      const dot = entry.lastIndexOf('.')
      const extension = dot === -1 ? '' : entry.slice(dot).toLowerCase()
      if (!IMAGE_EXTENSIONS.has(extension)) continue
      const path = join(this.directory, entry)
      if (!wholeDirectory && !targets.has(path)) continue
      await sweep(path)
    }

    // Residue is judged over the scope that was claimed, not the directory.
    const residue = []
    for (const entry of await readdir(this.directory).catch(() => [])) {
      const path = join(this.directory, entry)
      const dot = entry.lastIndexOf('.')
      const extension = dot === -1 ? '' : entry.slice(dot).toLowerCase()
      if (IMAGE_EXTENSIONS.has(extension) && (wholeDirectory || targets.has(path))) residue.push(path)
    }

    this.history.push({ round: round.round, files: round.files.map((file) => file.path), removed: removed.length, at: new Date().toISOString() })
    if (this.currentBySession.get(round.sessionId) === round) this.currentBySession.delete(round.sessionId)

    return {
      directory: this.directory,
      scope: wholeDirectory ? 'whole-directory' : allRounds ? 'all-rounds' : 'this-round',
      removed,
      failed,
      residue,
      clean: residue.length === 0 && failed.length === 0,
    }
  }

  /**
   * A round-shaped record for a number this session has already closed, so
   * cleanup can be aimed at an earlier round by the id the caller was given.
   */
  roundFiles(roundId) {
    const entry = this.history.find((item) => item.round === roundId)
    if (entry === undefined) return null
    return { round: entry.round, files: entry.files.map((path) => ({ path })) }
  }

  /** Every round number still nameable in this process, newest first. */
  knownRounds() {
    const numbers = new Set(this.history.map((entry) => entry.round))
    for (const round of this.currentBySession.values()) numbers.add(round.round)
    return [...numbers].sort((left, right) => right - left)
  }

  /** Directory listing plus existence check, used by the cleanup report. */  async inventory() {
    const exists = await stat(this.directory).then(() => true).catch(() => false)
    if (!exists) return { directory: this.directory, exists: false, images: [], stray: [] }
    const entries = await readdir(this.directory, { withFileTypes: true }).catch(() => [])
    const images = []
    const stray = []
    for (const entry of entries) {
      const dot = entry.name.lastIndexOf('.')
      const extension = dot === -1 ? '' : entry.name.slice(dot).toLowerCase()
      if (entry.isDirectory()) {
        stray.push({ name: entry.name, kind: 'directory' })
      } else if (IMAGE_EXTENSIONS.has(extension)) {
        images.push({ name: entry.name, bytes: await stat(join(this.directory, entry.name)).then((s) => s.size).catch(() => 0) })
      } else {
        stray.push({ name: entry.name, kind: 'file' })
      }
    }
    return { directory: this.directory, exists: true, images, stray }
  }
}

/**
 * Validate a target point against the captured region and the margins of a
 * real click.
 *
 * The margin is not arbitrary and it is not caution: it is the half-extent of
 * the verification marker. A marker drawn closer to an edge than its own size
 * is clipped, the visible part's centroid is dragged inward by about half the
 * clipped amount, and a verification that reports a centroid several pixels
 * from the point it drew is not a verification at all. Measured on this
 * display: unclipped the centroid is exact, while 8 px from the edge it reads
 * 1.1 px inward and 1 px from the edge 3.0 px inward.
 *
 * Rather than clicking a point whose check is unreliable, the plugin stops and
 * says so.
 */
export function validateTarget(x, y, meta, margin) {
  const problems = []
  const scale = (meta.ratio === undefined ? 1 : meta.ratio) * (meta.zoom === undefined || meta.zoom === null ? 1 : meta.zoom)
  const right = meta.originX + meta.imageWidth / scale
  const bottom = meta.originY + meta.imageHeight / scale
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    problems.push('the target coordinates are not finite numbers')
    return problems
  }
  if (x < meta.originX || y < meta.originY || x >= right || y >= bottom) {
    problems.push(
      `the target (${x.toFixed(1)}, ${y.toFixed(1)}) lies outside the region this round is currently showing, `
      + `[${String(meta.originX)}, ${String(meta.originY)}] .. [${(right - 1).toFixed(0)}, ${(bottom - 1).toFixed(0)}]. `
      + 'A zoomed frame only covers its own rectangle; call screen_zoom again for a different area, or screen_capture to return to the full screen.',
    )
    return problems
  }
  if (x - meta.originX < margin || y - meta.originY < margin || right - 1 - x < margin || bottom - 1 - y < margin) {
    const distances = [
      ['left', x - meta.originX],
      ['top', y - meta.originY],
      ['right', right - 1 - x],
      ['bottom', bottom - 1 - y],
    ]
    const nearest = distances.reduce((best, entry) => (entry[1] < best[1] ? entry : best))
    problems.push(
      `the target (${x.toFixed(1)}, ${y.toFixed(1)}) is ${nearest[1].toFixed(1)} px from the ${nearest[0]} screen edge, closer than the `
      + `${String(margin)} px the verification marker needs to be measurable. A marker that close is clipped, and its measured `
      + 'position would be several pixels away from the point it drew, so this click is refused rather than risked. '
      + 'If the element must be clicked, bring it away from the edge first (maximize or move the window, or capture that monitor with '
      + 'monitor_index and adjust the window), then run the round again.',
    )
  }
  return problems
}
