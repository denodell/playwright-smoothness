// Turns a measured run's trace screenshots into a WebM replay: each frame with a panel saying how
// drawn the list was, a red BLANK marker on blank frames, and a timeline of the whole run.
import type { Browser } from '@playwright/test';
import { PACKAGE_NAME } from '../constants.js';
import { muxWebM, type EncodedFrame } from './webm.js';

/** Replays play this many times slower than real time: at 60fps, blank frames flash past unseen. */
const REPLAY_SLOWDOWN = 4;
/** Height of the panel under each frame. */
const PANEL_HEIGHT = 196;
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
  const decode = (b64: string) => createImageBitmap(new Blob([bytes(b64)], { type: 'image/jpeg' }));
  const first = await decode(args.jpegs[0]!);
  const imgW = first.width;
  const imgH = first.height;
  first.close();

  // Layout: the screenshot inset on a dark stage, and a panel underneath.
  const pad = 20;
  const even = (n: number) => n + (n % 2);
  const width = even(imgW + pad * 2);
  const height = even(pad + imgH + args.panel);
  const sx = imgW / args.viewport.width;
  const sy = imgH / args.viewport.height;
  const font =
    '-apple-system, BlinkMacSystemFont, "SF Pro Text", Inter, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
  const color = {
    stage: '#0a0a0b',
    text: '#f5f5f7',
    muted: '#8e8e93',
    faint: 'rgba(255, 255, 255, 0.14)',
    drawn: '#30d158',
    blank: '#ff453a',
  };

  const canvas = new OffscreenCanvas(width, height);
  const g = canvas.getContext('2d')!;
  const text = (
    s: string,
    x: number,
    y: number,
    size: number,
    weight: number,
    fill: string,
    align: CanvasTextAlign = 'left',
  ) => {
    g.font = `${weight} ${size}px ${font}`;
    g.fillStyle = fill;
    g.textAlign = align;
    g.fillText(s, x, y);
  };
  const fit = (s: string, max: number) => {
    if (g.measureText(s).width <= max) return s;
    while (s.length > 1 && g.measureText(s + '…').width > max) s = s.slice(0, -1);
    return s + '…';
  };
  const seconds = (ms: number) => `${(ms / 1000).toFixed(2)} s`;

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
  const blankCount = args.drawn.filter((d) => d < args.blankShare).length;

  for (let i = 0; i < n; i++) {
    const img = await decode(args.jpegs[i]!);
    const drawn = args.drawn[i]!;
    const blank = drawn < args.blankShare;
    g.fillStyle = color.stage;
    g.fillRect(0, 0, width, height);

    // The screenshot, with rounded corners.
    g.save();
    g.beginPath();
    g.roundRect(pad, pad, imgW, imgH, 12);
    g.clip();
    g.drawImage(img, pad, pad);
    img.close();

    // The list: a hairline when drawn; tinted and outlined in red when blank.
    const x = pad + args.rect.x * sx;
    const y = pad + args.rect.y * sy;
    const w = args.rect.width * sx;
    const h = args.rect.height * sy;
    if (blank) {
      g.fillStyle = 'rgba(255, 69, 58, 0.10)';
      g.fillRect(x, y, w, h);
    }
    g.lineWidth = blank ? 3 : 1.5;
    g.strokeStyle = blank ? color.blank : 'rgba(255, 255, 255, 0.55)';
    g.beginPath();
    g.roundRect(x + g.lineWidth / 2, y + g.lineWidth / 2, w - g.lineWidth, h - g.lineWidth, 8);
    g.stroke();
    if (blank) {
      g.font = `700 11px ${font}`;
      g.letterSpacing = '1.5px';
      const label = 'BLANK';
      const pillW = g.measureText(label).width + 20;
      g.fillStyle = color.blank;
      g.beginPath();
      g.roundRect(x + 12, y + 12, pillW, 22, 11);
      g.fill();
      text(label, x + 22, y + 27, 11, 700, '#fff');
      g.letterSpacing = '0px';
    }
    g.restore();

    // Panel: the check's name, then this frame's drawn share, position and time.
    const left = pad;
    const right = width - pad;
    let py = pad + imgH + 34;
    g.font = `500 12px ${font}`;
    const speed = `${args.slowdown}× slower`;
    const speedW = g.measureText(speed).width;
    text(fit(args.title, right - left - speedW - 24), left, py, 12, 500, color.muted);
    text(speed, right, py, 12, 500, color.muted, 'right');

    py += 46;
    const pct = `${Math.round(drawn * 100)}%`;
    text(pct, left, py, 34, 600, blank ? color.blank : color.text);
    g.font = `600 34px ${font}`;
    const pctW = g.measureText(pct).width;
    text(blank ? 'drawn · blank frame' : 'drawn', left + pctW + 8, py, 13, 500, color.muted);
    text(`Frame ${i + 1} of ${n}`, right, py - 16, 13, 600, color.text, 'right');
    text(`${seconds(args.timesMs[i]!)} of ${seconds(total)}`, right, py, 12, 500, color.muted, 'right');

    // Timeline: one bar per frame, as tall as the frame was drawn, green or red; frames still
    // to come are dimmed. A dashed line marks the blank threshold.
    const trackTop = py + 26;
    const trackH = 44;
    const trackW = right - left;
    const step = trackW / n;
    const barW = Math.max(1, step - (step > 3 ? 1 : 0));
    g.fillStyle = 'rgba(255, 255, 255, 0.04)';
    g.beginPath();
    g.roundRect(left - 6, trackTop - 6, trackW + 12, trackH + 12, 8);
    g.fill();
    for (let j = 0; j < n; j++) {
      const d = args.drawn[j]!;
      const barH = Math.max(4, d * trackH);
      g.globalAlpha = j <= i ? 1 : 0.28;
      g.fillStyle = d < args.blankShare ? color.blank : color.drawn;
      g.beginPath();
      g.roundRect(left + j * step, trackTop + trackH - barH, barW, barH, Math.min(1.5, barW / 2));
      g.fill();
    }
    g.globalAlpha = 1;
    g.strokeStyle = color.faint;
    g.lineWidth = 1;
    g.setLineDash([3, 4]);
    g.beginPath();
    const thresholdY = trackTop + trackH - args.blankShare * trackH;
    g.moveTo(left, thresholdY);
    g.lineTo(right, thresholdY);
    g.stroke();
    g.setLineDash([]);
    const headX = left + (i + 0.5) * step;
    g.fillStyle = '#fff';
    g.fillRect(headX - 1, trackTop - 6, 2, trackH + 8);
    g.beginPath();
    g.arc(headX, trackTop - 7, 4, 0, Math.PI * 2);
    g.fill();

    const footY = trackTop + trackH + 30;
    text(`${blankCount} of ${n} frames blank`, left, footY, 11, 500, color.muted);
    const legend = `blank below ${Math.round(args.blankShare * 100)}% drawn`;
    g.font = `500 11px ${font}`;
    const legendX = right - g.measureText(legend).width;
    g.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    g.setLineDash([3, 4]);
    g.beginPath();
    g.moveTo(legendX - 26, footY - 4);
    g.lineTo(legendX - 8, footY - 4);
    g.stroke();
    g.setLineDash([]);
    text(legend, right, footY, 11, 500, color.muted, 'right');

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
