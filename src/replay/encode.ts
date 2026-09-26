// Turns a measured run's trace screenshots into a WebM replay: each frame with a panel saying how
// drawn the list was, a red BLANK marker on blank frames, and a timeline of the whole run.
import type { Browser } from '@playwright/test';
import { PACKAGE_NAME } from '../constants.js';
import { muxWebM, type EncodedFrame } from './webm.js';

/** Replays play this many times slower than real time: at 60fps, blank frames flash past unseen. */
const REPLAY_SLOWDOWN = 4;
/** A key frame this often, so the report's player can seek. */
const KEY_FRAME_EVERY = 30;
const REPLAY_BITRATE = 2_000_000;

/** WebCodecs needs a secure context; http://localhost is one, and Playwright serves it itself. */
const REPLAY_URL = 'http://localhost/__playwright-smoothness-replay';

export interface ReplayInput {
  /** Base64 JPEGs of the viewport, in order. */
  jpegs: string[];
  /** Each frame's time from the first, in real ms. */
  timesMs: number[];
  /** Each frame's drawn share relative to the list at rest, 0..1. */
  drawn: number[];
  /** Below this share a frame is blank. */
  blankShare: number;
  /** The list's client area and the viewport, in CSS pixels, to outline the list. */
  rect: { x: number; y: number; width: number; height: number };
  viewport: { width: number; height: number };
  title: string;
}

interface Chunk {
  timeMs: number;
  key: boolean;
  data: string;
}

/** Renders and encodes in the page. Self-contained: it's serialized into the browser. */
async function renderInPage(args: ReplayInput & { slowdown: number; keyEvery: number; bitrate: number }) {
  const bytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const decode = (b64: string) => createImageBitmap(new Blob([bytes(b64)], { type: 'image/jpeg' }));
  const first = await decode(args.jpegs[0]!);
  const imgW = first.width;
  const imgH = first.height;
  first.close();
  const n = args.jpegs.length;
  const total = args.timesMs[n - 1] ?? 0;
  const blankCount = args.drawn.filter((d) => d < args.blankShare).length;

  const pad = 28;
  const even = (v: number) => Math.ceil(v) + (Math.ceil(v) % 2);
  const width = even(imgW + pad * 2);
  const height = even(pad + imgH + 214);
  const sx = imgW / args.viewport.width;
  const sy = imgH / args.viewport.height;
  const sans = '"Helvetica Neue", Helvetica, Arial, "Liberation Sans", sans-serif';
  const c = {
    paper: '#ffffff',
    ink: '#1a1a1a',
    graphite: '#77776f',
    off: '#ecebe6',
    future: '#d8d7d1',
    blank: '#ff4f00',
  };

  const canvas = new OffscreenCanvas(width, height);
  const g = canvas.getContext('2d')!;
  const label = (
    s: string,
    x: number,
    y: number,
    fill = c.graphite,
    align: CanvasTextAlign = 'left',
    size = 9,
  ) => {
    g.font = `600 ${size}px ${sans}`;
    g.letterSpacing = '1.4px';
    g.fillStyle = fill;
    g.textAlign = align;
    g.fillText(s.toUpperCase(), x, y);
    g.letterSpacing = '0px';
  };
  const fit = (s: string, max: number) => {
    if (g.measureText(s).width <= max) return s;
    while (s.length > 1 && g.measureText(s + '…').width > max) s = s.slice(0, -1);
    return s + '…';
  };

  // A 5x7 dot-matrix face for readouts, like a device's display. Unlit dots are drawn faintly.
  const glyphs: Record<string, string> = {
    '0': '01110100011001110101110011000101110',
    '1': '00100011000010000100001000010001110',
    '2': '01110100010000100010001000100011111',
    '3': '11110000010000101110000010000111110',
    '4': '00010001100101010010111110001000010',
    '5': '11111100001111000001000011000101110',
    '6': '00110010001000011110100011000101110',
    '7': '11111000010001000100010000100001000',
    '8': '01110100011000101110100011000101110',
    '9': '01110100011000101111000010001001100',
    '%': '11001110100001000100010000101110011',
    '/': '00001000100001000100010000100010000',
    '.': '00000000000000000000000000110001100',
    s: '00000000000111110000011100000111110',
    B: '11110100011000111110100011000111110',
    L: '10000100001000010000100001000011111',
    A: '01110100011000111111100011000110001',
    N: '10001110011010110011100011000110001',
    K: '10001100101010011000101001001010001',
    ' ': '00000000000000000000000000000000000',
  };
  const dotText = (s: string, x: number, y: number, cell: number, on: string, off: string | null) => {
    const r = cell * 0.36;
    for (const ch of s) {
      const bits = glyphs[ch] ?? glyphs[' ']!;
      for (let k = 0; k < 35; k++) {
        const lit = bits[k] === '1';
        if (!lit && !off) continue;
        g.fillStyle = lit ? on : off!;
        g.beginPath();
        g.arc(x + (k % 5) * cell + cell / 2, y + Math.floor(k / 5) * cell + cell / 2, r, 0, Math.PI * 2);
        g.fill();
      }
      x += cell * 6;
    }
    return x;
  };
  const dotWidth = (s: string, cell: number) => s.length * cell * 6 - cell;
  const meter = (x: number, y: number, h: number, drawn: number, blank: boolean) => {
    const lit = Math.round(drawn * 10);
    for (let k = 0; k < 10; k++) {
      g.fillStyle = k < lit ? (blank ? c.blank : c.ink) : c.off;
      g.fillRect(x + k * 7, y, 4, h);
    }
  };
  const secs = (ms: number) => `${(ms / 1000).toFixed(2)}s`;
  const pad3 = (v: number) => String(v).padStart(String(n).length, '0');

  // The list on the screenshot: a hairline when drawn; when blank, an orange halftone screen and
  // a tag.
  const markList = (ox: number, oy: number, blank: boolean) => {
    const x = ox + args.rect.x * sx;
    const y = oy + args.rect.y * sy;
    const w = args.rect.width * sx;
    const h = args.rect.height * sy;
    if (!blank) {
      g.strokeStyle = 'rgba(26, 26, 26, 0.35)';
      g.lineWidth = 1;
      g.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
      return;
    }
    g.save();
    g.beginPath();
    g.rect(x, y, w, h);
    g.clip();
    g.fillStyle = 'rgba(255, 79, 0, 0.35)';
    for (let yy = y + 4; yy < y + h; yy += 8)
      for (let xx = x + 4 + ((yy - y) % 16 ? 4 : 0); xx < x + w; xx += 8) {
        g.beginPath();
        g.arc(xx, yy, 1.4, 0, Math.PI * 2);
        g.fill();
      }
    g.restore();
    g.strokeStyle = c.blank;
    g.lineWidth = 2;
    g.strokeRect(x + 1, y + 1, w - 2, h - 2);
    const tagW = dotWidth('BLANK', 2) + 12;
    g.fillStyle = c.blank;
    g.fillRect(x + 2, y + 2, tagW, 20);
    dotText('BLANK', x + 8, y + 5, 2, c.paper, null);
  };

  const chunks: Chunk[] = [];
  let failure = '';
  const encoder = new VideoEncoder({
    output: (chunk) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      let s = '';
      for (let i = 0; i < data.length; i += 0x8000) s += String.fromCharCode(...data.subarray(i, i + 0x8000));
      chunks.push({ timeMs: chunk.timestamp / 1000, key: chunk.type === 'key', data: btoa(s) });
    },
    error: (e) => {
      failure = String(e);
    },
  });
  encoder.configure({ codec: 'vp8', width, height, bitrate: args.bitrate, framerate: 60 / args.slowdown });

  for (let i = 0; i < n; i++) {
    const img = await decode(args.jpegs[i]!);
    const drawn = args.drawn[i]!;
    const blank = drawn < args.blankShare;
    const pct = `${Math.round(drawn * 100)}%`;
    g.fillStyle = c.paper;
    g.fillRect(0, 0, width, height);

    // Device: screenshot, then a display of dot-matrix readouts and a dot waveform.
    g.drawImage(img, pad, pad);
    img.close();
    g.strokeStyle = c.ink;
    g.lineWidth = 1;
    g.strokeRect(pad - 0.5, pad - 0.5, imgW + 1, imgH + 1);
    markList(pad, pad, blank);
    const left = pad;
    const right = width - pad;
    let y = pad + imgH + 30;
    g.font = `500 12px ${sans}`;
    g.fillStyle = c.ink;
    g.textAlign = 'left';
    g.fillText(fit(args.title, right - left - 120), left, y);
    label(`${args.slowdown}× slower`, right, y, c.graphite, 'right');

    y += 26;
    const col = (right - left) / 3;
    label('Drawn', left, y);
    label('Frame', left + col, y);
    label('Time', left + col * 2, y);
    const cell = 3;
    const endX = dotText(pct.padStart(4, ' '), left, y + 10, cell, blank ? c.blank : c.ink, c.off);
    meter(endX + 6, y + 10, 21, drawn, blank);
    dotText(`${pad3(i + 1)}/${n}`, left + col, y + 10, cell, c.ink, c.off);
    dotText(secs(args.timesMs[i]!), left + col * 2, y + 10, cell, c.ink, c.off);

    // Dot waveform: one column per frame, placed by time, as many dots high as it was drawn.
    const top = y + 50;
    const rows = 12;
    const pitch = 4;
    const base = top + rows * pitch;
    const xAt = (ms: number) => left + 2 + (ms / (total || 1)) * (right - left - 4);
    for (let j = 0; j < n; j++) {
      const d = args.drawn[j]!;
      const lit = Math.max(1, Math.round(d * rows));
      const x = xAt(args.timesMs[j]!);
      for (let k = 0; k < lit; k++) {
        g.fillStyle = j > i ? c.future : d < args.blankShare ? c.blank : c.ink;
        g.beginPath();
        g.arc(x, base - k * pitch, 1.3, 0, Math.PI * 2);
        g.fill();
      }
    }
    // The blank threshold: a faint dotted row across the width, between two rows of dots.
    const ty = base - (Math.round(args.blankShare * rows) - 0.5) * pitch;
    g.fillStyle = c.future;
    for (let x = left; x <= right; x += 3) g.fillRect(x, ty, 1, 1);
    label(`${Math.round(args.blankShare * 100)}%`, left - 6, ty + 3, c.graphite, 'right', 7);

    // Playhead: a small triangle under the waveform.
    const hx = xAt(args.timesMs[i]!);
    g.fillStyle = c.ink;
    g.beginPath();
    g.moveTo(hx, base + 5);
    g.lineTo(hx - 4, base + 11);
    g.lineTo(hx + 4, base + 11);
    g.closePath();
    g.fill();
    label(`${blankCount} of ${n} frames blank`, left, base + 30, blankCount ? c.blank : c.graphite);
    label(`0s to ${secs(total)}`, right, base + 30, c.graphite, 'right');

    const frame = new VideoFrame(canvas, { timestamp: Math.round(args.timesMs[i]! * args.slowdown * 1000) });
    encoder.encode(frame, { keyFrame: i % args.keyEvery === 0 });
    frame.close();
  }
  // Hold the last frame briefly so the replay doesn't end abruptly.
  const hold = new VideoFrame(canvas, { timestamp: Math.round((total * args.slowdown + 1000) * 1000) });
  encoder.encode(hold, { keyFrame: false });
  hold.close();
  await encoder.flush();
  encoder.close();
  return { width, height, chunks, failure };
}

/**
 * Encodes a replay in a throwaway page of the same Chromium (no dependency). Returns the WebM
 * bytes, or a reason it couldn't be made.
 */
export async function encodeReplay(
  browser: Browser,
  input: ReplayInput,
): Promise<Uint8Array | { unavailable: string }> {
  if (input.jpegs.length === 0) return { unavailable: 'no frames to replay' };
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.route(REPLAY_URL, (r) =>
      r.fulfill({ contentType: 'text/html', body: '<!doctype html><title>replay</title>' }),
    );
    await page.goto(REPLAY_URL);
    if (!(await page.evaluate(() => typeof VideoEncoder !== 'undefined'))) {
      return { unavailable: "this browser has no WebCodecs VideoEncoder, so replays can't be encoded" };
    }
    const out = await page.evaluate(renderInPage, {
      ...input,
      slowdown: REPLAY_SLOWDOWN,
      keyEvery: KEY_FRAME_EVERY,
      bitrate: REPLAY_BITRATE,
    });
    if (out.failure) return { unavailable: `the replay couldn't be encoded: ${out.failure}` };
    const frames: EncodedFrame[] = out.chunks
      .sort((a, b) => a.timeMs - b.timeMs)
      .map((c) => ({ timeMs: c.timeMs, key: c.key, data: Uint8Array.from(Buffer.from(c.data, 'base64')) }));
    if (!frames[0]?.key) return { unavailable: "the replay's first frame wasn't a key frame" };
    return muxWebM(frames, out.width, out.height, PACKAGE_NAME);
  } catch (err) {
    return { unavailable: `the replay couldn't be made: ${String(err).split('\n')[0]}` };
  } finally {
    await context.close();
  }
}
