// Base64 VLQ, as used by source map v3 `mappings` (https://tc39.es/ecma426/).

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const VALUE = new Int8Array(128).fill(-1);
for (let i = 0; i < BASE64.length; i++) VALUE[BASE64.charCodeAt(i)] = i;

const CONTINUATION = 32; // bit 6: more digits follow
const DIGIT_MASK = 31; // low 5 bits: value

/**
 * Decodes one segment's VLQ numbers from `text[start..end)`. Returns null on a malformed
 * segment rather than throwing, so one bad segment can't sink a whole map.
 */
export function decodeSegment(text: string, start: number, end: number): number[] | null {
  const out: number[] = [];
  let value = 0;
  let shift = 0;
  for (let i = start; i < end; i++) {
    const code = text.charCodeAt(i);
    const digit = code < 128 ? VALUE[code]! : -1;
    if (digit < 0) return null;
    value += (digit & DIGIT_MASK) * 2 ** shift;
    if (digit & CONTINUATION) {
      shift += 5;
      if (shift > 50) return null; // beyond what a double holds exactly
      continue;
    }
    // The lowest bit is the sign.
    out.push(value % 2 === 1 ? -Math.floor(value / 2) : Math.floor(value / 2));
    value = 0;
    shift = 0;
  }
  return shift === 0 ? out : null;
}
