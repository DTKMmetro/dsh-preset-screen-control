/**
 * How a captured frame reaches the model.
 *
 * There are two ways to put an image in a tool result and only one of them is
 * correct:
 *
 *   an image content block — `{ type: 'image', attachment }` — which the request
 *   adapter resolves against the attachment store and sends to the provider as
 *   an actual image part. This is the supported path, and the one the provider's
 *   own serializer has a branch for.
 *
 *   a text block holding a `data:image/png;base64,...` URL — which is just text.
 *   Half a megabyte of it, at roughly 1.5 characters per token, is hundreds of
 *   thousands of tokens of base64 for a single frame. It cannot be what the
 *   provider is meant to receive, and a conversation that appears to work is one
 *   where something else is dropping or truncating it.
 *
 * So the plugin prefers the image block and says so. The text form is kept only
 * as an explicitly-reported fallback for a deployment with no attachment store,
 * never as the silent default.
 *
 * @module screen-control/delivery
 */

/** The last path segment, for a filename-shaped display name. */
function baseName(path) {
  const cut = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  return cut === -1 ? path : path.slice(cut + 1)
}

/** Content blocks for one image, resolved against the attachment store. */
export class ImageDelivery {  constructor(attachments) {
    this.attachments = attachments
    // Keyed by tool call id: a result is finalized with the execution that
    // produced it, and this keeps concurrent calls from handing each other's
    // image to the wrong result.
    this.pending = new Map()
  }

  get mode() {
    return this.attachments === undefined || this.attachments === null ? 'text-fallback' : 'image-block'
  }

  /**
   * Store the frame and remember it for this call.
   *
   * Returns the placeholder string that goes into the tool result's text; the
   * image itself is attached when the result is finalized, so the model gets
   * `[image: path — attached as an image block]` plus a real image part rather
   * than a wall of base64.
   */
  async offer(callId, png, label) {
    if (this.mode === 'text-fallback') {
      return {
        text: `[image: ${label} — no attachment store in this deployment, so the frame is inlined as base64 text below]`,
        base64: png.toString('base64'),
      }
    }
    try {
      // `name` is a display name and is never interpreted as a path, so only the
      // basename is passed: an absolute Windows path in a display field invites
      // a reader to treat it as one.
      const ref = await this.attachments.saveImage({ data: new Uint8Array(png), mediaType: 'image/png', name: baseName(label) })
      this.pending.set(callId, { ref, label })
      return { text: `[image: ${label} — attached as an image block, ${String(png.length)} bytes]`, base64: null }
    } catch (error) {
      // A store that exists but refuses this image is reported, not hidden: a
      // silent fall back to half a megabyte of base64 would be far worse than
      // a tool result that says the image could not be attached.
      return {
        text: `[image: ${label} — the attachment store refused this frame (${error.message}); inlined as base64 text instead]`,
        base64: png.toString('base64'),
      }
    }
  }

  /** The image block for one call, if a frame was offered for it. */
  take(callId) {
    const entry = this.pending.get(callId)
    if (entry === undefined) return null
    this.pending.delete(callId)
    return { type: 'image', attachment: entry.ref }
  }

  /** Drop a frame that will never be finalized, so nothing is retained for it. */
  discard(callId) {
    this.pending.delete(callId)
  }

  /** How many frames are still waiting to be finalized. */
  get outstanding() {
    return this.pending.size
  }
}

/**
 * Resolve the attachment service, or undefined when this deployment has none.
 *
 * It is read optionally rather than declared as an injection: a preset that
 * cannot find an attachment store should still run and say so, not refuse to
 * mount. The shape is checked too — a bound service exposes `saveImage`, and
 * treating something else as a store would report "the store refused" for what
 * is really "there is no store here", which is a materially different and much
 * more confusing message.
 */
export function resolveAttachments(ctx) {
  try {
    const candidate = ctx.get('attachments')
    if (candidate === undefined || candidate === null) return undefined
    return typeof candidate.saveImage === 'function' ? candidate : undefined
  } catch {
    return undefined
  }
}
