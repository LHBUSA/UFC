/* Image derivatives without sharp.
 *
 * The Node pipeline used sharp for portrait/card/thumb, and sharp is a native
 * binary that cannot run in workerd. Both consumers -- workers/ufc-api and
 * web/lib/db.ts -- build the card and thumb URLs by string substitution on
 * r2_key, so uploading only the original would not degrade gracefully; it would
 * produce 404s where fighter images should be. The derivatives are not
 * optional.
 *
 * Cloudflare's image transformations do the same job through fetch(), with
 * gravity:'auto' standing in for sharp's attention crop.
 *
 * THE DANGEROUS PART, AND WHY EVERY OUTPUT IS MEASURED
 *
 * When image transformation is unavailable -- wrong plan, wrong zone, or a
 * request that never touched a configured zone -- fetch does NOT fail. It
 * quietly returns the ORIGINAL bytes. Trusting it would upload a 2000px
 * original as card.jpg: no error anywhere, every counter green, and a
 * subtly-wrong site. So the JPEG dimensions are parsed back out of the returned
 * bytes and checked against what was asked for. A transform that did not happen
 * is an error here, not a silent pass-through.
 */

/** Read pixel dimensions straight out of a JPEG's SOF marker. */
export function jpegSize(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;   /* not a JPEG */
  let i = 2;
  while (i < b.length - 9) {
    if (b[i] !== 0xff) { i += 1; continue; }
    const marker = b[i + 1];
    /* SOF0-SOF3, SOF5-SOF7, SOF9-SOF11, SOF13-SOF15 carry the frame header.
     * DHT/DAC/RST/SOS and friends do not. */
    const isSOF = (marker >= 0xc0 && marker <= 0xcf)
      && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    const len = (b[i + 2] << 8) | b[i + 3];
    if (isSOF) {
      return { height: (b[i + 5] << 8) | b[i + 6], width: (b[i + 7] << 8) | b[i + 8] };
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) { i += 2; continue; }
    if (len <= 0) return null;
    i += 2 + len;
  }
  return null;
}

export function pngSize(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length < 24) return null;
  const sig = [0x89, 0x50, 0x4e, 0x47];
  for (let i = 0; i < 4; i += 1) if (b[i] !== sig[i]) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { width: dv.getUint32(16), height: dv.getUint32(20) };
}

export const imageSize = (bytes) => jpegSize(bytes) || pngSize(bytes);

/**
 * Transform one image and PROVE it happened.
 *
 * @returns {{ok, bytes, width, height, reason}}
 */
export async function derive(srcUrl, { width, height, quality = 82, fit = 'cover', requireExact = true, fetchImpl = fetch } = {}) {
  let res;
  try {
    res = await fetchImpl(srcUrl, {
      headers: { 'User-Agent': 'PropBetEdgeUFC/1.1 (https://ufc.propbetedge.ai; sales@localhomebuyersusa.com)' },
      cf: {
        image: {
          width, height,
          fit,
          gravity: 'auto',      /* saliency crop; sharp's attention strategy */
          format: 'jpeg',
          quality,
          metadata: 'none',
        },
      },
    });
  } catch (e) {
    return { ok: false, reason: `fetch failed: ${String(e?.message || e).slice(0, 160)}` };
  }
  if (!res.ok) return { ok: false, reason: `http ${res.status}` };

  const bytes = new Uint8Array(await res.arrayBuffer());
  const size = imageSize(bytes);
  if (!size) return { ok: false, reason: 'response is not a decodable JPEG/PNG' };

  /* The check that matters. An untransformed pass-through arrives with the
   * ORIGINAL dimensions, which is exactly what a working transform must not
   * return. One pixel of tolerance for rounding. */
  /* A cover crop has an exact contract: it must come back at the size asked
   * for. A scale-down does not — it fits INSIDE the box and preserves aspect,
   * so the test is that it is no larger than requested and actually changed if
   * the original was bigger. Applying the exact test to a bounded transform
   * would reject every correct result. */
  if (!requireExact) {
    const within = size.width <= width + 1 && size.height <= height + 1;
    if (!within) {
      return { ok: false, width: size.width, height: size.height,
        reason: `bounded transform did not apply: asked to fit within ${width}x${height}, received ${size.width}x${size.height}` };
    }
    return { ok: true, bytes, width: size.width, height: size.height, content_type: res.headers.get('content-type') || 'image/jpeg' };
  }

  const okW = Math.abs(size.width - width) <= 1;
  const okH = Math.abs(size.height - height) <= 1;
  if (!okW || !okH) {
    return {
      ok: false, width: size.width, height: size.height,
      reason: `transform did not apply: asked ${width}x${height}, received ${size.width}x${size.height}`
        + ' (Cloudflare returns the original bytes rather than an error when image transformations are unavailable)',
    };
  }
  return { ok: true, bytes, width: size.width, height: size.height, content_type: res.headers.get('content-type') || 'image/jpeg' };
}
