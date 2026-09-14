/**
 * The screen-control plugin.
 *
 * One image is captured. It is never a window handle, never a re-render, and
 * never a stale cache: the pixels the model reasons about are the pixels the
 * display was showing, and the coordinates computed from them are the
 * coordinates the click is delivered to.
 *
 * Responsibilities are split so that the risky part is small and testable:
 *
 *   win32.mjs    — capture, DPI, coordinates, `SendInput`
 *   imaging.mjs  — grid, compression, mark rendering, mark detection
 *   round.mjs    — artifacts, ratios, verification state, cleanup
 *   tools.mjs    — the ten model-facing capabilities
 *   index.mjs    — assembly
 *
 * This file is the entry point a preset row names. It registers into the
 * preset's own tool layer, so the capabilities exist only for an agent
 * composed from this preset and are absent from every other agent in the
 * process.
 *
 * @module screen-control
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolutionBases, dependencyReport, loadDependency } from './deps.mjs'
import { loadWin32 } from './win32.mjs'
import { loadSharp } from './imaging.mjs'
import { RoundStore } from './round.mjs'
import { buildTools } from './tools.mjs'
import { ImageDelivery, resolveAttachments } from './delivery.mjs'

export const name = 'screen-control'

export const inject = ['tools']

export const apply = async (ctx, config) => {
  const options = config === undefined || config === null ? {} : config

  // The preset directory itself is the first anchor, which is what makes a
  // copied or relocated preset keep working.
  const bases = resolutionBases()

  const report = dependencyReport(bases)
  const missing = report.filter((entry) => !entry.ok)
  if (missing.length > 0) {
    throw new Error(
      `screen-control: cannot start without its native dependencies: ${missing.map((m) => m.name).join(', ')}. `
      + `Resolved against: ${bases.join(' | ')}`,
    )
  }

  const win = await loadWin32(bases)
  const sharp = await loadSharp(bases)

  // The host registry stores a COMPILED ToolDefinition, so the author-facing
  // parameter spec has to go through the harness's own `defineTool` first: that
  // is what turns `{ field: { type: 'string', required: true } }` into the raw
  // object-rooted JSON Schema the registry validates, and what turns the
  // `json` output wildcard into its annotation-only form. Registering the spec
  // directly fails the preset mount with "unsupported JSON schema".
  const defineTool = await loadDependency('@deepseek-ai/dsh-tools', bases, 'defineTool')
  if (typeof defineTool !== 'function') {
    throw new Error('screen-control: the resolved @deepseek-ai/dsh-tools does not export defineTool; the tool definitions cannot be compiled for the registry')
  }

  // Every capture belongs under the preset's own screenshots directory, never
  // on the desktop, in Temp, or anywhere else in the user profile.
  //
  // The default is derived from THIS module's location rather than written out
  // as an absolute path: the plugin sits at
  // `<preset>/screen-control-plugin/plugin/index.mjs`, so two levels up is the
  // preset directory under whichever home the deployment actually uses. An
  // absolute path baked in at development time would point at a directory that
  // does not exist on anyone else's machine, and the first capture would fail
  // trying to create it.
  const pluginDirectory = dirname(fileURLToPath(import.meta.url))
  const defaultScreenshotDir = join(dirname(dirname(pluginDirectory)), 'screenshots')
  const screenshotDir = typeof options.screenshotDir === 'string' && options.screenshotDir !== ''
    ? options.screenshotDir
    : defaultScreenshotDir

  const store = new RoundStore({
    screenshotDir,
    // The marker's half-extent, with a pixel of slack. Below this the marker is
    // clipped by a screen edge and its measured centroid drifts inward, so the
    // click is refused instead: measured on this display the error is 0.2 px at
    // 12 px from an edge and 3.0 px at 1 px from it.
    minTargetMargin: Number.isFinite(options.minTargetMargin) ? options.minTargetMargin : 14,
    markTolerance: Number.isFinite(options.markTolerance) ? options.markTolerance : 2,
    driftThreshold: Number.isFinite(options.driftThreshold) ? options.driftThreshold : 18,
    maxRounds: Number.isFinite(options.maxRounds) ? options.maxRounds : 6,
  })

  const sessionId = globalThis.process !== undefined && typeof globalThis.process.env?.DSH_SESSION_ID === 'string'
    ? globalThis.process.env.DSH_SESSION_ID
    : 'local'

  // Frames reach the model as image blocks when this deployment has an
  // attachment store, and as an explicitly-labelled fallback when it does not.
  const attachments = resolveAttachments(ctx)
  const delivery = new ImageDelivery(attachments)

  // Every round-scoped capability re-checks the display geometry through this,
  // so a resolution change cannot turn a verified point into a misclick.
  store.geometryProver = () => win.displaySnapshot()

  const tools = buildTools({ win, sharp, store, sessionId, options, delivery })

  // Compile each definition, then register through the injected registry so the
  // capabilities land in this preset's layer and are disposed with the fiber.
  const disposers = tools.map((definition) => ctx.tools.register(defineTool(definition)))

  // The screenshot directory is created eagerly so the first capture cannot
  // fail on an absent directory mid-round.
  await store.ensureDirectory()

  ctx.effect(() => () => {
    for (const dispose of disposers) dispose()
  })

  const snapshot = win.displaySnapshot()
  ctx.logger?.info?.(
    `screen-control: ${String(tools.length)} capabilities ready; capture ${String(snapshot.virtual.width)}x${String(snapshot.virtual.height)} physical at ${String(snapshot.scaleFactor)}x, markers refused within ${String(store.minTargetMargin)} px of an edge, frames delivered as ${delivery.mode}`,
  )
}

export default { name, inject, apply }
