/**
 * Dependency resolution for a locally authored preset.
 *
 * A preset under the user root lives where Node's upward `node_modules` walk
 * never reaches the harness's own dependencies, so a bare `import 'koffi'`
 * from a preset plugin fails. This module finds the installed harness instead
 * and resolves the few packages the plugin needs from exactly there.
 *
 * The anchors are tried in order:
 *
 *   1. `harnessBase` — the base URL Cordis loaded this preset's rows from, when
 *      the caller supplies it.
 *   2. the preset's own directory, so a preset that ships or links its own
 *      `node_modules` wins and a relocated preset keeps working.
 *   3. `DSH_HOME/profiles/*` — the documented layout.
 *   4. the running host's entry script and `process.cwd()`.
 *
 * `@deepseek-ai/dsh-tools` is not optional: the host tool registry stores a
 * compiled `ToolDefinition`, so the plugin must run its definitions through
 * that package's `defineTool` to turn the author-facing parameter spec into the
 * raw JSON Schema the registry validates. Registering the spec directly fails
 * the mount.
 *
 * @module screen-control/deps
 */

import { createRequire } from 'node:module'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PACKAGES = ['@deepseek-ai/dsh-tools', 'koffi', 'sharp']

function uniquePaths(paths) {
  const seen = new Set()
  const out = []
  for (const path of paths) {
    if (typeof path !== 'string' || path === '') continue
    const key = path.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(path)
  }
  return out
}

/**
 * Every base a bare specifier could legitimately resolve against, best first.
 *
 * `harnessBase` is passed in by the plugin's `apply()` — Cordis exposes the
 * base URL the preset's rows were loaded from — and leads when present. The
 * preset directory is next, because Node's upward walk from it is exactly how
 * a user-supplied `node_modules` beside the preset would be found; a directory
 * cannot be walked *down* into, so listing the profile directories explicitly
 * is what covers the layout this deployment actually uses.
 */
export function resolutionBases(harnessBase) {
  const bases = []

  if (typeof harnessBase === 'string' && harnessBase !== '') {
    try {
      bases.push(dirname(fileURLToPath(harnessBase.endsWith('/') ? `${harnessBase}package.json` : harnessBase)))
    } catch {
      // Not a usable URL; the remaining anchors still apply.
    }
  }

  try {
    bases.push(dirname(fileURLToPath(import.meta.url)))
  } catch {
    // Unreachable for a file-scheme module, but keep the chain total.
  }

  const home = globalThis.process !== undefined ? globalThis.process.env?.DSH_HOME : undefined
  if (typeof home === 'string' && home !== '') {
    bases.push(home)
    const profiles = join(home, 'profiles')
    bases.push(profiles)
    bases.push(join(profiles, 'web'))
    try {
      for (const entry of readdirSync(profiles, { withFileTypes: true })) {
        if (entry.isDirectory()) bases.push(join(profiles, entry.name))
      }
    } catch {
      // An absent or unreadable profiles directory is not an error here.
    }
  }

  const argvEntry = globalThis.process !== undefined ? globalThis.process.argv?.[1] : undefined
  if (typeof argvEntry === 'string') bases.push(dirname(resolve(argvEntry)))
  bases.push(globalThis.process !== undefined ? globalThis.process.cwd() : process.cwd())

  // A global npm layout keeps packages under the roaming app data root.
  const appData = globalThis.process !== undefined ? globalThis.process.env?.APPDATA : undefined
  if (typeof appData === 'string') bases.push(join(appData, 'npm', 'node_modules'))

  return uniquePaths(bases)
}

function packageVisibleFrom(base, name) {
  let dir = base
  for (;;) {
    if (existsSync(join(dir, 'node_modules', name, 'package.json'))) return true
    const parent = dirname(dir)
    if (parent === dir) return false
    dir = parent
  }
}

/**
 * Resolve one package to a file URL, or throw a message that names the fix.
 *
 * A package that exists but cannot be reached through a require anchor is
 * still imported by absolute path, because a pnpm store entry is a real
 * directory even when no `node_modules` symlink points at it.
 */
function resolvePackage(name, bases) {
  let lastError = null
  for (const base of bases) {
    try {
      const require = createRequire(join(base, 'package.json'))
      return pathToFileURL(require.resolve(name)).href
    } catch (error) {
      lastError = error
    }
  }
  for (const base of bases) {
    const entry = join(base, 'node_modules', name, 'package.json')
    if (existsSync(entry)) return pathToFileURL(entry).href
  }
  throw new Error(
    `screen-control: cannot resolve the "${name}" package. It is installed beside the harness, so this means the `
    + `plugin could not locate the harness installation. Tried ${String(bases.length)} anchor(s): ${bases.join(', ')}. `
    + `Last resolver error: ${lastError === null ? 'none' : lastError.message}`,
  )
}

const cache = new Map()

/**
 * Import one dependency, memoized per process.
 *
 * `default` is preferred only when it looks like the package's whole surface;
 * `@deepseek-ai/dsh-tools` is the counterexample that makes this necessary —
 * its `default` export is the Cordis plugin class while the helpers this plugin
 * needs (`defineTool`) are named exports. Taking `default` blindly returned a
 * class with no `defineTool` and broke the mount, so a namespace that carries
 * the named export is used as-is.
 */
export async function loadDependency(name, bases, exportName) {
  if (!PACKAGES.includes(name)) throw new Error(`screen-control: "${name}" is not a resolvable dependency of this plugin`)
  const key = `${name}::${exportName ?? ''}::${bases[0] ?? ''}`
  const cached = cache.get(key)
  if (cached !== undefined) return cached
  const promise = (async () => {
    const href = resolvePackage(name, bases)
    const module = await import(href)
    if (exportName !== undefined) {
      const named = module[exportName]
      if (named === undefined) {
        throw new Error(`screen-control: the resolved "${name}" does not export "${exportName}"`)
      }
      return named
    }
    return module.default ?? module
  })()
  cache.set(key, promise)
  try {
    return await promise
  } catch (error) {
    cache.delete(key)
    throw error
  }
}

/** Pre-flight: report which of the plugin's dependencies are reachable, and from where. */
export function dependencyReport(bases) {
  return PACKAGES.map((name) => {
    const visibleFrom = bases.filter((base) => packageVisibleFrom(base, name))
    try {
      return { name, ok: true, href: resolvePackage(name, bases), visibleFrom: visibleFrom.length }
    } catch (error) {
      return { name, ok: false, href: null, visibleFrom: visibleFrom.length, error: error.message }
    }
  })
}
