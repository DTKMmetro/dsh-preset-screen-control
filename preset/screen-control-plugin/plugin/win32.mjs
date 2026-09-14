/**
 * Windows host primitives for the screen-control preset.
 *
 * Everything here talks to the real display stack through Win32, in-process,
 * with no child process:
 *
 *   - the desktop is captured with GDI `BitBlt` from the screen DC, which is
 *     what PrtSc / WeChat screen capture do — the composited frame as shown,
 *     never `PrintWindow` on a window handle;
 *   - input is synthesized with `SendInput`, the same entry point the hardware
 *     path uses, so DPI virtualisation and UIPI apply for real rather than
 *     being papered over.
 *
 * Two coordinate spaces matter and this module is the only place that knows
 * both:
 *
 *   physical desktop pixels — what the capture contains, what the grid labels
 *   print, and what `SendInput` absolute coordinates resolve to;
 *
 *   logical pixels — what a DPI-unaware caller sees (`GetSystemMetrics` before
 *   awareness is set, `System.Windows.Forms.Screen.Bounds`).
 *
 * The process is forced to Per-Monitor-V2 awareness at load, which is what
 * collapses those two into one: after that every metric, every capture, and
 * every synthesized coordinate is physical. Without it a 175% display reports
 * 1463x914 logical against a 2560x1600 physical screen and every click lands
 * at 57% of its intended position.
 *
 * @module screen-control/win32
 */

import { loadDependency } from './deps.mjs'

export const SRCCOPY = 0x00cc0020
const DIB_RGB_COLORS = 0
const HALFTONE = 4

export const SM = {
  XVIRTUALSCREEN: 76,
  YVIRTUALSCREEN: 77,
  CXVIRTUALSCREEN: 78,
  CYVIRTUALSCREEN: 79,
  CXSCREEN: 0,
  CYSCREEN: 1,
}

export const MOUSEEVENTF = {
  MOVE: 0x0001,
  LEFTDOWN: 0x0002,
  LEFTUP: 0x0004,
  RIGHTDOWN: 0x0008,
  RIGHTUP: 0x0010,
  MIDDLEDOWN: 0x0020,
  MIDDLEUP: 0x0040,
  WHEEL: 0x0800,
  HWHEEL: 0x1000,
  ABSOLUTE: 0x8000,
  VIRTUALDESK: 0x4000,
}

export const KEYEVENTF = { EXTENDEDKEY: 0x0001, KEYUP: 0x0002, UNICODE: 0x0004, SCANCODE: 0x0008 }

/** Keys that need KEYEVENTF_EXTENDEDKEY to be distinguished from their numpad twins. */
export const EXTENDED_KEYS = new Set([
  0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2d, 0x2e, 0x5b, 0x5c, 0x5d, 0x6f, 0x90,
])

/** Virtual-key names for `key_press`; values are the Win32 VK codes. */
export const VIRTUAL_KEYS = {
  backspace: 0x08, tab: 0x09, clear: 0x0c, enter: 0x0d, return: 0x0d, shift: 0x10,
  ctrl: 0x11, control: 0x11, alt: 0x12, menu: 0x12, pause: 0x13, capslock: 0x14,
  esc: 0x1b, escape: 0x1b, space: 0x20, pageup: 0x21, pagedown: 0x22, end: 0x23,
  home: 0x24, left: 0x25, up: 0x26, right: 0x27, down: 0x28, select: 0x29,
  print: 0x2a, snapshot: 0x2c, insert: 0x2d, delete: 0x2e, del: 0x2e, help: 0x2f,
  '0': 0x30, '1': 0x31, '2': 0x32, '3': 0x33, '4': 0x34, '5': 0x35, '6': 0x36,
  '7': 0x37, '8': 0x38, '9': 0x39,
  a: 0x41, b: 0x42, c: 0x43, d: 0x44, e: 0x45, f: 0x46, g: 0x47, h: 0x48, i: 0x49,
  j: 0x4a, k: 0x4b, l: 0x4c, m: 0x4d, n: 0x4e, o: 0x4f, p: 0x50, q: 0x51, r: 0x52,
  s: 0x53, t: 0x54, u: 0x55, v: 0x56, w: 0x57, x: 0x58, y: 0x59, z: 0x5a,
  lwin: 0x5b, rwin: 0x5c, apps: 0x5d, sleep: 0x5f,
  numpad0: 0x60, numpad1: 0x61, numpad2: 0x62, numpad3: 0x63, numpad4: 0x64,
  numpad5: 0x65, numpad6: 0x66, numpad7: 0x67, numpad8: 0x68, numpad9: 0x69,
  multiply: 0x6a, add: 0x6b, separator: 0x6c, subtract: 0x6d, decimal: 0x6e, divide: 0x6f,
  f1: 0x70, f2: 0x71, f3: 0x72, f4: 0x73, f5: 0x74, f6: 0x75, f7: 0x76, f8: 0x77,
  f9: 0x78, f10: 0x79, f11: 0x7a, f12: 0x7b, f13: 0x7c, f14: 0x7d, f15: 0x7e,
  numlock: 0x90, scrolllock: 0x91,
  semicolon: 0xba, plus: 0xbb, comma: 0xbc, minus: 0xbd, period: 0xbe, slash: 0xbf,
  backquote: 0xc0, tilde: 0xc0, bracketleft: 0xdb, backslash: 0xdc, bracketright: 0xdd, quote: 0xde,
}

/** Per-Monitor-V2 awareness: DPI virtualisation off, physical pixels everywhere. */
const DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4
const DPI_AWARENESS_CONTEXT_SYSTEM_AWARE = -2

/**
 * Bind the Win32 surface once per process.
 *
 * Loading the libraries, registering the struct layouts, and forcing DPI
 * awareness are all process-global facts, so this runs once and is reused.
 */
export async function loadWin32(bases) {
  const koffi = await loadDependency('koffi', bases)
  const user32 = koffi.load('user32.dll')
  const gdi32 = koffi.load('gdi32.dll')

  let shcore = null
  try {
    shcore = koffi.load('shcore.dll')
  } catch {
    shcore = null
  }

  // koffi keeps one process-global type registry keyed by name, so registering
  // the same name twice throws "Duplicate type name". A preset can be composed
  // more than once in a process — an update, a second session's mount, a
  // standing remount — and a module-level flag would not survive that, because
  // a fresh module instance re-runs this function against the same registry.
  //
  // Names are therefore unique per call: the base name is attempted first, then
  // a unique suffix. The cache avoids redundant registrations within one call.
  // Nothing outside this module ever names these types, so there is no contract
  // to preserve by reusing a fixed name across calls.
  const typeCache = new Map()
  const uniqueSuffix = `${String(Date.now() % 100000000)}_${String(Math.floor(Math.random() * 1000000))}`
  const define = (base, factory) => {
    const cached = typeCache.get(base)
    if (cached !== undefined) return cached
    let type
    try {
      type = factory(base)
    } catch (error) {
      if (!String(error.message).includes('Duplicate type name')) throw error
      type = factory(`${base}_${uniqueSuffix}`)
    }
    typeCache.set(base, type)
    return type
  }

  const POINT = define('SC_POINT', (n) => koffi.struct(n, { x: 'int32', y: 'int32' }))
  const RECT = define('SC_RECT', (n) => koffi.struct(n, { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' }))
  const MOUSEINPUT = define('SC_MOUSEINPUT', (n) => koffi.struct(n, {
    dx: 'int32', dy: 'int32', mouseData: 'uint32', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr',
  }))
  const KEYBDINPUT = define('SC_KEYBDINPUT', (n) => koffi.struct(n, {
    wVk: 'uint16', wScan: 'uint16', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr',
  }))
  const HARDWAREINPUT = define('SC_HARDWAREINPUT', (n) => koffi.struct(n, { uMsg: 'uint32', wParamL: 'uint16', wParamH: 'uint16' }))
  const INPUTUNION = define('SC_INPUTUNION', (n) => koffi.union(n, { mi: MOUSEINPUT, ki: KEYBDINPUT, hi: HARDWAREINPUT }))
  const INPUT = define('SC_INPUT', (n) => koffi.struct(n, { type: 'uint32', u: INPUTUNION }))
  const INPUT_ARRAY = koffi.array(INPUT, 64)
  const INPUT_SIZE = koffi.sizeof(INPUT)
  const INPUT_LIST = koffi.array(INPUT, 1)

  if (INPUT_SIZE !== 40) {
    throw new Error(`screen-control: the INPUT struct measured ${INPUT_SIZE} bytes instead of 40; refusing to synthesize input with a mismatched layout`)
  }

  const f = {
    setProcessDpiAwarenessContext: user32.func('bool SetProcessDpiAwarenessContext(void *value)'),
    getThreadDpiAwarenessContext: user32.func('void *GetThreadDpiAwarenessContext()'),
    getAwarenessFromDpiAwarenessContext: user32.func('int GetAwarenessFromDpiAwarenessContext(void *value)'),
    getSystemMetrics: user32.func('int GetSystemMetrics(int index)'),
    getDpiForSystem: user32.func('uint32 GetDpiForSystem()'),
    getDC: user32.func('void *GetDC(void *hwnd)'),
    releaseDC: user32.func('int ReleaseDC(void *hwnd, void *hdc)'),
    getCursorPos: user32.func('bool GetCursorPos(_Out_ SC_POINT *p)'),
    setCursorPos: user32.func('bool SetCursorPos(int x, int y)'),
    getForegroundWindow: user32.func('void *GetForegroundWindow()'),
    getWindowRect: user32.func('bool GetWindowRect(void *hwnd, _Out_ SC_RECT *r)'),
    getClassNameW: user32.func('int GetClassNameW(void *hwnd, _Out_ char16_t *buf, int max)'),
    getWindowTextW: user32.func('int GetWindowTextW(void *hwnd, _Out_ char16_t *buf, int max)'),
    isWindowVisible: user32.func('bool IsWindowVisible(void *hwnd)'),
    windowFromPoint: user32.func('void *WindowFromPoint(SC_POINT pt)'),
    enumDisplayMonitors: user32.func('bool EnumDisplayMonitors(void *hdc, void *clip, void *proc, intptr data)'),
    getWindowThreadProcessId: user32.func('uint32 GetWindowThreadProcessId(void *hwnd, _Out_ uint32 *pid)'),
    sendInput: user32.func('uint32 SendInput(uint32 nInputs, void *pInputs, int cbSize)'),
  }

  const kernel32 = koffi.load('kernel32.dll')
  f.openProcess = kernel32.func('void *OpenProcess(uint32 access, bool inherit, uint32 pid)')
  f.queryFullProcessImageNameW = kernel32.func('bool QueryFullProcessImageNameW(void *handle, uint32 flags, _Out_ char16_t *name, _Inout_ uint32 *size)')
  f.closeHandle = kernel32.func('bool CloseHandle(void *handle)')

  const g = {
    createCompatibleDC: gdi32.func('void *CreateCompatibleDC(void *hdc)'),
    createCompatibleBitmap: gdi32.func('void *CreateCompatibleBitmap(void *hdc, int w, int h)'),
    selectObject: gdi32.func('void *SelectObject(void *hdc, void *obj)'),
    bitBlt: gdi32.func('bool BitBlt(void *dst, int x, int y, int w, int h, void *src, int sx, int sy, uint32 rop)'),
    deleteObject: gdi32.func('bool DeleteObject(void *obj)'),
    deleteDC: gdi32.func('bool DeleteDC(void *hdc)'),
    getDIBits: gdi32.func('int GetDIBits(void *hdc, void *hbm, uint32 start, uint32 lines, _Out_ uint8_t *bits, _Inout_ void *bmi, uint32 usage)'),
    stretchBlt: gdi32.func('bool StretchBlt(void *dst, int dx, int dy, int dw, int dh, void *src, int sx, int sy, int sw, int sh, uint32 rop)'),
    setStretchBltMode: gdi32.func('int SetStretchBltMode(void *hdc, int mode)'),
  }

  const getLastError = koffi.load('kernel32.dll').func('uint32 GetLastError()')

  let getDpiForMonitor = null
  if (shcore !== null) {
    try {
      getDpiForMonitor = shcore.func('int GetDpiForMonitor(void *hmon, int type, _Out_ uint32 *dpiX, _Out_ uint32 *dpiY)')
    } catch {
      getDpiForMonitor = null
    }
  }

  // Forcing awareness must happen before any metric is read. The context
  // handle is a pseudo-handle (a small negative integer), not a real pointer.
  let awareness = 'unavailable'
  try {
    if (f.setProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)) {
      awareness = 'per-monitor-v2'
    } else if (f.setProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_SYSTEM_AWARE)) {
      awareness = 'system'
    }
  } catch {
    // A host that already fixed awareness (an embedded app, a manifest) rejects
    // the call; whatever it chose still applies and the metrics below report it.
    awareness = 'pre-set'
  }
  const awarenessCode = f.getAwarenessFromDpiAwarenessContext(f.getThreadDpiAwarenessContext())

  // ── display identity ──────────────────────────────────────────────────────

  // Callback prototypes cannot be looked up by name, and koffi rejects a
  // duplicate prototype name outright, so this one is registered under a name
  // unique to this call.
  const MONITORENUMPROC = koffi.proto(`bool __stdcall SC_MonitorEnumProc_${String(Date.now() % 100000000)}_${String(Math.floor(Math.random() * 1000000))}(void *hmon, void *hdc, void *rect, intptr data)`)

  /**
   * Every monitor's physical bounds, in virtual-desktop coordinates.
   *
   * `EnumDisplayMonitors` reports the same space the capture and `SendInput`
   * use, so these rectangles are directly comparable with observed pixels. On a
   * secondary display left of the primary, `left` and `top` are negative — the
   * sign is meaningful and is preserved all the way through to the click.
   */
  function listMonitors() {
    const found = []
    const callback = koffi.register((hmon, hdc, rectPtr) => {
      const r = koffi.decode(rectPtr, RECT)
      let dpiX = null
      let dpiY = null
      if (getDpiForMonitor !== null) {
        try {
          const outX = [0]
          const outY = [0]
          if (getDpiForMonitor(hmon, 0, outX, outY) === 0) {
            dpiX = outX[0]
            dpiY = outY[0]
          }
        } catch {
          dpiX = null
          dpiY = null
        }
      }
      found.push({
        index: found.length,
        handle: String(hmon),
        left: r.left,
        top: r.top,
        right: r.right,
        bottom: r.bottom,
        width: r.right - r.left,
        height: r.bottom - r.top,
        dpiX,
        dpiY,
        scale: dpiX === null ? null : Math.round((dpiX / 96) * 10000) / 10000,
      })
      return true
    }, koffi.pointer(MONITORENUMPROC))

    try {
      f.enumDisplayMonitors(null, null, callback, 0)
    } finally {
      koffi.unregister(callback)
    }
    return found
  }

  /**
   * The snapshot every capture and every coordinate decision is keyed to:
   * virtual-desktop origin and extent in physical pixels, plus the monitors and
   * the system DPI.
   */
  function displaySnapshot() {
    const monitors = listMonitors()
    const primary = monitors.length > 0 ? monitors[0] : null
    const dpi = f.getDpiForSystem()
    return {
      awareness,
      awarenessCode,
      dpi,
      scaleFactor: Math.round((dpi / 96) * 10000) / 10000,
      virtual: {
        x: f.getSystemMetrics(SM.XVIRTUALSCREEN),
        y: f.getSystemMetrics(SM.YVIRTUALSCREEN),
        width: f.getSystemMetrics(SM.CXVIRTUALSCREEN),
        height: f.getSystemMetrics(SM.CYVIRTUALSCREEN),
      },
      primary: primary === null ? null : { width: primary.width, height: primary.height, dpi: primary.dpiX },
      monitors,
      monitorCount: monitors.length,
    }
  }

  /**
   * The exact rectangle a capture will cover.
   *
   * With a monitor index the whole monitor is used; without one the entire
   * virtual desktop is, so a second display is never silently cropped out.
   */
  function selectRegion(monitorIndex) {
    const monitors = listMonitors()
    if (monitors.length === 0) throw new Error('screen-control: the display stack reported no monitors')

    if (monitorIndex === undefined || monitorIndex === null || monitorIndex === '') {
      const vx = f.getSystemMetrics(SM.XVIRTUALSCREEN)
      const vy = f.getSystemMetrics(SM.YVIRTUALSCREEN)
      const vw = f.getSystemMetrics(SM.CXVIRTUALSCREEN)
      const vh = f.getSystemMetrics(SM.CYVIRTUALSCREEN)
      if (vw <= 0 || vh <= 0) throw new Error('screen-control: the virtual desktop reported a non-positive extent')
      return { x: vx, y: vy, width: vw, height: vh, kind: 'virtual-desktop', monitor: null }
    }

    const index = Number(monitorIndex)
    if (!Number.isInteger(index) || index < 0 || index >= monitors.length) {
      throw new Error(`screen-control: monitor_index ${String(monitorIndex)} is out of range; this machine reports ${String(monitors.length)} monitor(s)`)
    }
    const monitor = monitors[index]
    return { x: monitor.left, y: monitor.top, width: monitor.width, height: monitor.height, kind: 'monitor', monitor }
  }

  // ── capture ───────────────────────────────────────────────────────────────

  /**
   * Capture a desktop rectangle as top-down RGBA.
   *
   * `BitBlt` from the screen DC reads the composited desktop, which is the
   * "what is actually on the display" the caller asked for. `GetDIBits` then
   * reads the bitmap back bottom-up as BGRA; both flips are applied here so
   * every consumer downstream sees ordinary top-down RGBA with the origin at
   * the rectangle's top-left.
   *
   * `StretchBlt` with HALFTONE is used when a target size is given, so a
   * reduced capture is produced in the same pass rather than a second one.
   */
  function captureRaw(region, target) {
    const screenDc = f.getDC(null)
    if (screenDc === null) throw new Error('screen-control: GetDC(NULL) failed; no desktop DC is available')

    let memDc = null
    let bitmap = null
    let previous = null
    try {
      memDc = g.createCompatibleDC(screenDc)
      if (memDc === null) throw new Error('screen-control: CreateCompatibleDC failed')

      const outWidth = target === undefined ? region.width : Math.max(1, Math.round(target.width))
      const outHeight = target === undefined ? region.height : Math.max(1, Math.round(target.height))

      bitmap = g.createCompatibleBitmap(screenDc, outWidth, outHeight)
      if (bitmap === null) throw new Error('screen-control: CreateCompatibleBitmap failed')
      previous = g.selectObject(memDc, bitmap)

      if (outWidth === region.width && outHeight === region.height) {
        if (!g.bitBlt(memDc, 0, 0, outWidth, outHeight, screenDc, region.x, region.y, SRCCOPY)) {
          throw new Error('screen-control: BitBlt from the screen DC failed')
        }
      } else {
        g.setStretchBltMode(memDc, HALFTONE)
        if (!g.stretchBlt(memDc, 0, 0, outWidth, outHeight, screenDc, region.x, region.y, region.width, region.height, SRCCOPY)) {
          throw new Error('screen-control: StretchBlt from the screen DC failed')
        }
      }

      const header = Buffer.alloc(40)
      header.writeUInt32LE(40, 0)
      header.writeInt32LE(outWidth, 4)
      header.writeInt32LE(outHeight, 8)
      header.writeUInt16LE(1, 12)
      header.writeUInt16LE(32, 14)
      header.writeUInt32LE(0, 16)

      const stride = outWidth * 4
      const bgra = Buffer.alloc(stride * outHeight)
      const lines = g.getDIBits(memDc, bitmap, 0, outHeight, bgra, header, DIB_RGB_COLORS)
      if (lines !== outHeight) {
        throw new Error(`screen-control: GetDIBits returned ${String(lines)} of ${String(outHeight)} scan lines`)
      }

      // BGRA bottom-up -> RGBA top-down, row by row.
      const rgba = Buffer.alloc(stride * outHeight)
      for (let y = 0; y < outHeight; y++) {
        const src = (outHeight - 1 - y) * stride
        const dst = y * stride
        for (let x = 0; x < outWidth; x++) {
          const s = src + x * 4
          const d = dst + x * 4
          rgba[d] = bgra[s + 2]
          rgba[d + 1] = bgra[s + 1]
          rgba[d + 2] = bgra[s]
          rgba[d + 3] = 255
        }
      }
      return { data: rgba, width: outWidth, height: outHeight, channels: 4 }
    } finally {
      if (memDc !== null && previous !== null && previous !== undefined) g.selectObject(memDc, previous)
      if (bitmap !== null) g.deleteObject(bitmap)
      if (memDc !== null) g.deleteDC(memDc)
      f.releaseDC(null, screenDc)
    }
  }

  // ── cursor and windows ────────────────────────────────────────────────────

  function cursorPosition() {
    const p = {}
    if (!f.getCursorPos(p)) throw new Error('screen-control: GetCursorPos failed')
    return { x: p.x, y: p.y }
  }

  function setCursorPosition(x, y) {
    return f.setCursorPos(Math.round(x), Math.round(y))
  }

  function readWindowString(reader, hwnd, size) {
    const buf = Buffer.alloc(size * 2)
    const length = reader(hwnd, buf, size)
    if (length <= 0) return ''
    return buf.toString('utf16le', 0, length * 2)
  }

  const EXECUTABLE_CACHE = new Map()

  /**
   * The process behind a window, so a caller can tell WHAT it is about to
   * drive rather than only what it is called.
   *
   * A window title and class say "dsh web [ConsoleWindowClass]"; they do not
   * say "this is a console, do not type a URL into it". Reported alongside
   * every window, this is what makes "which window holds focus" answerable
   * before input is delivered rather than after.
   */
  function processOfWindow(hwnd) {
    try {
      const pid = [0]
      f.getWindowThreadProcessId(hwnd, pid)
      const processId = pid[0]
      if (processId === 0) return null
      const cached = EXECUTABLE_CACHE.get(processId)
      if (cached !== undefined) return { processId, executable: cached }
      const handle = f.openProcess(0x1000, false, processId) // PROCESS_QUERY_LIMITED_INFORMATION
      if (handle === null || handle === undefined) return { processId, executable: null }
      try {
        const buffer = Buffer.alloc(1024 * 2)
        const size = [buffer.length]
        if (f.queryFullProcessImageNameW(handle, 0, buffer, size)) {
          const full = buffer.toString('utf16le', 0, size[0] * 2)
          const name = full.slice(full.lastIndexOf('\\') + 1)
          EXECUTABLE_CACHE.set(processId, name)
          return { processId, executable: name }
        }
        return { processId, executable: null }
      } finally {
        f.closeHandle(handle)
      }
    } catch {
      return null
    }
  }

  function describeWindow(hwnd) {
    if (hwnd === null || hwnd === undefined) return null
    const rect = {}
    const hasRect = f.getWindowRect(hwnd, rect)
    const owner = processOfWindow(hwnd)
    return {
      handle: String(hwnd),
      title: readWindowString(f.getWindowTextW, hwnd, 512),
      className: readWindowString(f.getClassNameW, hwnd, 256),
      processId: owner === null ? null : owner.processId,
      executable: owner === null ? null : owner.executable,
      visible: f.isWindowVisible(hwnd),
      bounds: hasRect ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } : null,
    }
  }

  /** One line naming a window, including the executable that owns it. */
  function describeWindowLine(window) {
    if (window === null) return 'none'
    const title = window.title === '' ? '(untitled)' : window.title
    const who = window.executable === null || window.executable === undefined ? 'unknown process' : window.executable
    return `${title} [${window.className}] (${who}${window.processId === null ? '' : ` pid ${String(window.processId)}`})`
  }

  /** Identify the foreground window, so a click can be attributed before it happens. */
  function foregroundWindow() {
    return describeWindow(f.getForegroundWindow())
  }

  /** The window that would receive a click at one physical desktop point. */
  function windowAt(x, y) {
    return describeWindow(f.windowFromPoint({ x: Math.round(x), y: Math.round(y) }))
  }

  // ── input synthesis ───────────────────────────────────────────────────────

  function flushInputs(records) {
    if (records.length === 0) return 0
    const buffer = Buffer.alloc(INPUT_SIZE * records.length)
    for (let i = 0; i < records.length; i++) {
      koffi.encode(buffer, i * INPUT_SIZE, INPUT_LIST, [records[i]])
    }
    const sent = f.sendInput(records.length, buffer, INPUT_SIZE)
    if (sent !== records.length) {
      const code = getLastError()
      // ERROR_ACCESS_DENIED (5) is UIPI: the target window belongs to a
      // higher-integrity process and Windows refused the injection outright.
      const detail = code === 5
        ? 'Windows blocked the injection with ERROR_ACCESS_DENIED (UIPI): the target window belongs to a higher-integrity process, so this host cannot drive it. Run the host at the same elevation as the target.'
        : `SendInput accepted ${String(sent)} of ${String(records.length)} events (GetLastError=${String(code)})`
      throw new Error(`screen-control: ${detail}`)
    }
    return sent
  }

  function mouseRecord(flags, dx, dy, mouseData) {
    return { type: 0, u: { mi: { dx, dy, mouseData: mouseData >>> 0, dwFlags: flags >>> 0, time: 0, dwExtraInfo: 0 } } }
  }

  function keyRecord(vk, scan, flags) {
    return { type: 1, u: { ki: { wVk: vk, wScan: scan, dwFlags: flags >>> 0, time: 0, dwExtraInfo: 0 } } }
  }

  /**
   * Absolute virtual-desktop coordinates, in SendInput's 0..65535 space.
   *
   * The normalization denominator is the virtual desktop and VIRTUALDESK is
   * set, so a negative origin on a left-hand secondary display still maps
   * correctly. Windows truncates these to the pixel grid; the round-trip check
   * in `moveCursorAbsolute` measures the residue rather than assuming it away.
   */
  function toAbsolute(x, y) {
    const vx = f.getSystemMetrics(SM.XVIRTUALSCREEN)
    const vy = f.getSystemMetrics(SM.YVIRTUALSCREEN)
    const vw = f.getSystemMetrics(SM.CXVIRTUALSCREEN)
    const vh = f.getSystemMetrics(SM.CYVIRTUALSCREEN)
    if (vw <= 1 || vh <= 1) throw new Error('screen-control: the virtual desktop extent is too small to normalize against')
    return [
      Math.round(((x - vx) * 65535) / (vw - 1)),
      Math.round(((y - vy) * 65535) / (vh - 1)),
    ]
  }

  /**
   * Move the cursor to an exact physical point, then prove where it landed.
   *
   * The read-back is the anti-misclick primitive: a click is only allowed to
   * proceed once the operating system reports the cursor on the intended
   * pixel. A one-pixel shortfall — the rounding residue of the 0..65535 grid,
   * observable at the far edge of a screen — is corrected by falling back to
   * `SetCursorPos`, which takes exact pixels and is not normalized at all.
   */
  function moveCursorAbsolute(x, y) {
    const targetX = Math.round(x)
    const targetY = Math.round(y)
    const [nx, ny] = toAbsolute(targetX, targetY)
    flushInputs([mouseRecord(MOUSEEVENTF.MOVE | MOUSEEVENTF.ABSOLUTE | MOUSEEVENTF.VIRTUALDESK, nx, ny, 0)])

    let actual = cursorPosition()
    let corrected = false
    if (actual.x !== targetX || actual.y !== targetY) {
      setCursorPosition(targetX, targetY)
      actual = cursorPosition()
      corrected = true
    }
    return {
      requested: { x: targetX, y: targetY },
      actual,
      exact: actual.x === targetX && actual.y === targetY,
      corrected,
      delta: { x: actual.x - targetX, y: actual.y - targetY },
    }
  }

  function buttonDown(right) {
    flushInputs([mouseRecord(right ? MOUSEEVENTF.RIGHTDOWN : MOUSEEVENTF.LEFTDOWN, 0, 0, 0)])
  }

  function buttonUp(right) {
    flushInputs([mouseRecord(right ? MOUSEEVENTF.RIGHTUP : MOUSEEVENTF.LEFTUP, 0, 0, 0)])
  }

  function wheelVertical(notches) {
    flushInputs([mouseRecord(MOUSEEVENTF.WHEEL, 0, 0, Math.round(notches * 120))])
  }

  function wheelHorizontal(notches) {
    flushInputs([mouseRecord(MOUSEEVENTF.HWHEEL, 0, 0, Math.round(notches * 120))])
  }

  function keyDown(vk) {
    flushInputs([keyRecord(vk, 0, EXTENDED_KEYS.has(vk) ? KEYEVENTF.EXTENDEDKEY : 0)])
  }

  function keyUp(vk) {
    flushInputs([keyRecord(vk, 0, (EXTENDED_KEYS.has(vk) ? KEYEVENTF.EXTENDEDKEY : 0) | KEYEVENTF.KEYUP)])
  }

  /**
   * Type text through `KEYEVENTF_UNICODE`, which delivers the characters
   * themselves instead of a keyboard layout's interpretation of them. That is
   * what makes arbitrary Unicode safe here: no layout lookup, no dead keys, and
   * no IME state can turn the requested text into different characters.
   */
  function typeUnicode(text) {
    const records = []
    for (const char of text) {
      const code = char.codePointAt(0)
      if (char === '\n') {
        records.push(keyRecord(0x0d, 0, 0), keyRecord(0x0d, 0, KEYEVENTF.KEYUP))
      } else if (code > 0xffff) {
        const offset = code - 0x10000
        const high = 0xd800 + (offset >> 10)
        const low = 0xdc00 + (offset & 0x3ff)
        records.push(keyRecord(0, high, KEYEVENTF.UNICODE), keyRecord(0, high, KEYEVENTF.UNICODE | KEYEVENTF.KEYUP))
        records.push(keyRecord(0, low, KEYEVENTF.UNICODE), keyRecord(0, low, KEYEVENTF.UNICODE | KEYEVENTF.KEYUP))
      } else {
        records.push(keyRecord(0, code, KEYEVENTF.UNICODE), keyRecord(0, code, KEYEVENTF.UNICODE | KEYEVENTF.KEYUP))
      }
    }
    let sent = 0
    for (let i = 0; i < records.length; i += 32) {
      sent += flushInputs(records.slice(i, i + 32))
    }
    return sent
  }

  /**
   * A coarse fingerprint of one square patch of the desktop, in physical
   * desktop coordinates, captured fresh and independent of any mark.
   *
   * This is what lets the click be gated on "the screen still looks the way it
   * did when I verified the target". A red crosshair drawn for the verification
   * image is not part of the desktop, so the fingerprint must be taken from
   * the live screen rather than from a marked bitmap.
   */
  function patchFingerprint(cx, cy, size = 144) {
    const half = Math.floor(size / 2)
    const region = { x: Math.round(cx) - half, y: Math.round(cy) - half, width: size, height: size }
    // Clamp to the virtual desktop so an edge target still yields 16 cells.
    const vx = f.getSystemMetrics(SM.XVIRTUALSCREEN)
    const vy = f.getSystemMetrics(SM.YVIRTUALSCREEN)
    const vw = f.getSystemMetrics(SM.CXVIRTUALSCREEN)
    const vh = f.getSystemMetrics(SM.CYVIRTUALSCREEN)
    const clampedX = Math.min(Math.max(region.x, vx), vx + vw - size)
    const clampedY = Math.min(Math.max(region.y, vy), vy + vh - size)
    const raw = captureRaw({ x: clampedX, y: clampedY, width: size, height: size })

    const cells = 16
    const step = Math.max(1, Math.floor(size / cells))
    const out = new Array(cells * cells)
    for (let gy = 0; gy < cells; gy++) {
      for (let gx = 0; gx < cells; gx++) {
        let sum = 0
        let count = 0
        for (let y = gy * step; y < (gy + 1) * step && y < raw.height; y++) {
          for (let x = gx * step; x < (gx + 1) * step && x < raw.width; x++) {
            const o = (y * raw.width + x) * 4
            // Rec. 601 luma, integer weights.
            sum += (raw.data[o] * 77 + raw.data[o + 1] * 150 + raw.data[o + 2] * 29) >> 8
            count++
          }
        }
        out[gy * cells + gx] = count === 0 ? 0 : Math.round(sum / count)
      }
    }
    return { cells, grid: out, patch: { x: clampedX, y: clampedY, width: size, height: size } }
  }

  /**
   * Mean absolute luma difference between two fingerprints, 0..255.
   *
   * A small value means the patch is visually unchanged; a large one means the
   * content under the target moved, appeared, or disappeared, which is exactly
   * the condition that would turn a verified point into a misclick.
   */
  function fingerprintDistance(left, right) {
    if (left === null || right === null) return Number.POSITIVE_INFINITY
    if (left.grid.length !== right.grid.length) return Number.POSITIVE_INFINITY
    let total = 0
    for (let i = 0; i < left.grid.length; i++) total += Math.abs(left.grid[i] - right.grid[i])
    return Math.round((total / left.grid.length) * 1000) / 1000
  }

  return {
    listMonitors,
    displaySnapshot,
    selectRegion,
    captureRaw,
    cursorPosition,
    setCursorPosition,
    foregroundWindow,
    describeWindowLine,
    windowAt,
    moveCursorAbsolute,
    buttonDown,
    buttonUp,
    wheelVertical,
    wheelHorizontal,
    keyDown,
    keyUp,
    typeUnicode,
    patchFingerprint,
    fingerprintDistance,
  }
}
