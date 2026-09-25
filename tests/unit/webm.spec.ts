import { test, expect } from '@playwright/test';
import { muxWebM, vint } from '../../src/replay/webm.js';

test('vint: EBML sizes', () => {
  expect(vint(0)).toEqual([0x80]);
  expect(vint(126)).toEqual([0xfe]);
  expect(vint(127)).toEqual([0x40, 0x7f]); // 127 is reserved in one byte
  expect(vint(300)).toEqual([0x41, 0x2c]);
});

const find = (bytes: Uint8Array, seq: number[]) => {
  outer: for (let i = 0; i <= bytes.length - seq.length; i++) {
    for (let j = 0; j < seq.length; j++) if (bytes[i + j] !== seq[j]) continue outer;
    return i;
  }
  return -1;
};
const count = (bytes: Uint8Array, seq: number[]) => {
  let n = 0;
  for (let i = find(bytes, seq); i >= 0;) {
    n++;
    const next = find(bytes.subarray(i + 1), seq);
    i = next < 0 ? -1 : i + 1 + next;
  }
  return n;
};

test('muxWebM: header, one track, a cluster per key frame, cues', () => {
  const frame = (timeMs: number, key: boolean) => ({ timeMs, key, data: new Uint8Array([9, 9, 9]) });
  const webm = muxWebM(
    [frame(0, true), frame(40, false), frame(80, true), frame(120, false)],
    500,
    576,
    'test',
  );
  expect([...webm.subarray(0, 4)]).toEqual([0x1a, 0x45, 0xdf, 0xa3]); // EBML
  expect(find(webm, [...new TextEncoder().encode('webm')])).toBeGreaterThan(0);
  expect(find(webm, [...new TextEncoder().encode('V_VP8')])).toBeGreaterThan(0);
  expect(count(webm, [0x1f, 0x43, 0xb6, 0x75])).toBe(2); // two clusters, one per key frame
  expect(count(webm, [0xa3, 0x87, 0x81])).toBe(4); // four SimpleBlocks (3 bytes of data + 4 of header)
  expect(find(webm, [0x1c, 0x53, 0xbb, 0x6b])).toBeGreaterThan(0); // Cues, for seeking
  // The second cluster's first block is a key frame at relative time 0.
  const second = find(webm.subarray(find(webm, [0x1f, 0x43, 0xb6, 0x75]) + 4), [0x1f, 0x43, 0xb6, 0x75]);
  expect(second).toBeGreaterThan(0);
});
