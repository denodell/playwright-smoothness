// Turns a measured run's trace screenshots into a WebM replay: each frame with a panel saying how
// drawn the list was, a red BLANK marker on blank frames, and a timeline of the whole run.
import type { Browser } from '@playwright/test';
import { PACKAGE_NAME } from '../constants.js';
import { muxWebM, type EncodedFrame } from './webm.js';

/** Replays play this many times slower than real time: at 60fps, blank frames flash past unseen. */
const REPLAY_SLOWDOWN = 4;
/** Height of the panel under each frame. */
const PANEL_HEIGHT = 76;
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
async function renderInPage(
  args: ReplayInput & { slowdown: number; panel: number; keyEvery: number; bitrate: number },
) {
  const bytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const first = await createImageBitmap(new Blob([bytes(args.jpegs[0]!)], { type: 'image/jpeg' }));
  const width = first.width + (first.width % 2);
  const imageHeight = first.height;
  const height = imageHeight + args.panel + ((imageHeight + args.panel) % 2);
  first.close();
  const sx = width / args.viewport.width;
  const sy = imageHeight / args.viewport.height;
  const canvas = new OffscreenCanvas(width, height);
  const g = canvas.getContext('2d')!;
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
  const n = args.jpegs.length;
  const total = args.timesMs[n - 1] ?? 0;
  for (let i = 0; i < n; i++) {
    const img = await createImageBitmap(new Blob([bytes(args.jpegs[i]!)], { type: 'image/jpeg' }));
    const blank = args.drawn[i]! < args.blankShare;
    g.fillStyle = '#18181b';
    g.fillRect(0, 0, width, height);
    g.drawImage(img, 0, 0);
    img.close();
    // The list, outlined; red and marked when the frame is blank.
    const x = args.rect.x * sx;
    const y = args.rect.y * sy;
    const w = args.rect.width * sx;
    const h = args.rect.height * sy;
    g.lineWidth = blank ? 6 : 2;
    g.strokeStyle = blank ? '#dc2626' : 'rgba(37, 99, 235, 0.8)';
    g.setLineDash(blank ? [] : [6, 4]);
    g.strokeRect(x + g.lineWidth / 2, y + g.lineWidth / 2, w - g.lineWidth, h - g.lineWidth);
    g.setLineDash([]);
    if (blank) {
      g.fillStyle = '#dc2626';
      g.fillRect(x + 12, y + 12, 86, 30);
      g.fillStyle = '#fff';
      g.font = '600 18px system-ui, sans-serif';
      g.fillText('BLANK', x + 22, y + 34);
    }
    // Panel: frame, time, drawn share, and the title.
    const py = imageHeight;
    g.fillStyle = '#f4f4f5';
    g.font = '600 15px system-ui, sans-serif';
    g.fillText(`Frame ${i + 1} of ${n}  ·  ${Math.round(args.timesMs[i]!)}ms`, 12, py + 22);
    g.fillStyle = blank ? '#fca5a5' : '#bbf7d0';
    g.fillText(`${Math.round(args.drawn[i]! * 100)}% drawn`, width - 118, py + 22);
    g.fillStyle = '#a1a1aa';
    g.font = '13px system-ui, sans-serif';
    g.fillText(
      `${args.title}  ·  ${args.slowdown}× slower than real time`.slice(0, Math.floor(width / 6.5)),
      12,
      py + 42,
    );
    // Timeline: one bar per frame (red when blank), with a playhead.
    const barTop = py + 52;
    const barH = 16;
    const bw = (width - 24) / n;
    for (let j = 0; j < n; j++) {
      const d = args.drawn[j]!;
      g.fillStyle = d < args.blankShare ? '#dc2626' : `rgba(34, 197, 94, ${0.35 + 0.65 * d})`;
      g.fillRect(12 + j * bw, barTop, Math.max(1, bw - (bw > 3 ? 1 : 0)), barH);
    }
    g.fillStyle = '#fff';
    g.fillRect(12 + i * bw - 1, barTop - 4, Math.max(3, bw), barH + 8);
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
      panel: PANEL_HEIGHT,
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
