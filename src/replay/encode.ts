// Turns a measured run's trace screenshots into a WebM replay: each frame with a panel saying how
// drawn the list was, a red BLANK marker on blank frames, and a timeline of the whole run.
import type { Browser } from '@playwright/test';
import { PACKAGE_NAME } from '../constants.js';
import { muxWebM, type EncodedFrame } from './webm.js';

/** Replays play this many times slower than real time: at 60fps, blank frames flash past unseen. */
const REPLAY_SLOWDOWN = 4;
/** Height of the panel under each frame. */
const PANEL_HEIGHT = 210;
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
  args: ReplayInput & { slowdown: number; panel: number; keyEvery: number; bitrate: number; meter: boolean },
) {
  const bytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const decode = (b64: string) => createImageBitmap(new Blob([bytes(b64)], { type: 'image/jpeg' }));
  const first = await decode(args.jpegs[0]!);
  const imgW = first.width;
  const imgH = first.height;
  first.close();

  // Layout: the screenshot framed on white paper, and an instrument panel underneath.
  const pad = 24;
  const even = (n: number) => n + (n % 2);
  const width = even(imgW + pad * 2);
  const height = even(pad + imgH + args.panel);
  const sx = imgW / args.viewport.width;
  const sy = imgH / args.viewport.height;
  const sans = '"Helvetica Neue", Helvetica, Arial, "Liberation Sans", sans-serif';
  const mono = 'ui-monospace, "SF Mono", Menlo, "DejaVu Sans Mono", "Liberation Mono", monospace';
  const color = {
    paper: '#ffffff',
    ink: '#111111',
    graphite: '#6b6b6b',
    rule: '#d9d9d9',
    grid: '#f1f1f1',
    future: '#e4e4e4',
    blank: '#d92d20',
  };

  const canvas = new OffscreenCanvas(width, height);
  const g = canvas.getContext('2d')!;
  const text = (
    s: string,
    x: number,
    y: number,
    face: string,
    size: number,
    weight: number,
    fill: string,
    align: CanvasTextAlign = 'left',
    tracking = 0,
  ) => {
    g.font = `${weight} ${size}px ${face}`;
    g.letterSpacing = `${tracking}px`;
    g.fillStyle = fill;
    g.textAlign = align;
    g.fillText(s, x, y);
    g.letterSpacing = '0px';
  };
  const fit = (s: string, max: number) => {
    if (g.measureText(s).width <= max) return s;
    while (s.length > 1 && g.measureText(s + '…').width > max) s = s.slice(0, -1);
    return s + '…';
  };
  const secs = (ms: number) => `${(ms / 1000).toFixed(2)}s`;
  const hline = (x0: number, x1: number, y: number, stroke: string) => {
    g.strokeStyle = stroke;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(x0, Math.round(y) + 0.5);
    g.lineTo(x1, Math.round(y) + 0.5);
    g.stroke();
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
  const n = args.jpegs.length;
  const total = args.timesMs[n - 1] ?? 0;
  const blankCount = args.drawn.filter((d) => d < args.blankShare).length;

  for (let i = 0; i < n; i++) {
    const img = await decode(args.jpegs[i]!);
    const drawn = args.drawn[i]!;
    const blank = drawn < args.blankShare;
    g.fillStyle = color.paper;
    g.fillRect(0, 0, width, height);
    g.drawImage(img, pad, pad);
    img.close();
    g.strokeStyle = color.ink;
    g.lineWidth = 1;
    g.strokeRect(pad - 0.5, pad - 0.5, imgW + 1, imgH + 1);

    // The list: a hairline when drawn; hatched and outlined in red when blank, the way a
    // technical drawing marks an empty space.
    const x = pad + args.rect.x * sx;
    const y = pad + args.rect.y * sy;
    const w = args.rect.width * sx;
    const h = args.rect.height * sy;
    if (blank) {
      g.save();
      g.beginPath();
      g.rect(x, y, w, h);
      g.clip();
      g.strokeStyle = 'rgba(217, 45, 32, 0.28)';
      g.lineWidth = 1;
      g.beginPath();
      for (let d = -h; d < w; d += 9) {
        g.moveTo(x + d, y + h);
        g.lineTo(x + d + h, y);
      }
      g.stroke();
      g.restore();
      g.strokeStyle = color.blank;
      g.lineWidth = 2;
      g.strokeRect(x + 1, y + 1, w - 2, h - 2);
      g.font = `700 10px ${sans}`;
      g.letterSpacing = '1.2px';
      const tagW = g.measureText('BLANK').width + 12;
      g.letterSpacing = '0px';
      g.fillStyle = color.blank;
      g.fillRect(x + 2, y + 2, tagW, 18);
      text('BLANK', x + 8, y + 15, sans, 10, 700, color.paper, 'left', 1.2);
    } else {
      g.strokeStyle = 'rgba(17, 17, 17, 0.35)';
      g.lineWidth = 1;
      g.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    }

    // Panel header: the check, and the replay speed.
    const left = pad;
    const right = width - pad;
    let py = pad + imgH + 30;
    g.font = `500 12px ${sans}`;
    const speed = `REPLAY · ${args.slowdown}× SLOWER`;
    g.letterSpacing = '1px';
    g.font = `500 10px ${sans}`;
    const speedW = g.measureText(speed).width;
    g.letterSpacing = '0px';
    g.font = `500 12px ${sans}`;
    text(fit(args.title, right - left - speedW - 24), left, py, sans, 12, 500, color.ink);
    text(speed, right, py, sans, 10, 500, color.graphite, 'right', 1);
    hline(left, right, py + 12, color.rule);

    // Readouts: drawn share, frame, time.
    py += 36;
    const col = (right - left) / 3;
    const readout = (i: number, label: string, value: string, fill: string) => {
      const cx = left + col * i;
      text(label, cx, py, sans, 9, 600, color.graphite, 'left', 1.2);
      text(value, cx, py + 22, mono, 17, 500, fill);
    };
    readout(0, 'DRAWN', `${Math.round(drawn * 100)}%`, blank ? color.blank : color.ink);
    if (args.meter) {
      // A ten-segment level meter after the value.
      g.font = `500 17px ${mono}`;
      const mx = left + g.measureText('100%').width + 12;
      const lit = Math.round(drawn * 10);
      for (let k = 0; k < 10; k++) {
        g.fillStyle = k < lit ? (blank ? color.blank : color.ink) : color.future;
        g.fillRect(mx + k * 6, py + 10, 4, 12);
      }
    }
    readout(1, 'FRAME', `${String(i + 1).padStart(String(n).length, '0')} / ${n}`, color.ink);
    readout(2, 'TIME', `${secs(args.timesMs[i]!)} / ${secs(total)}`, color.ink);

    // Strip chart: the drawn share as a stepped trace over time (each frame holds its value until
    // the next one), filled underneath; red where frames were blank, pale grey for frames still to
    // come. A faint grid follows the ruler's minor ticks, and a hairline marks the blank threshold.
    const trackTop = py + 44;
    const trackH = 40;
    const base = trackTop + trackH;
    const trackW = right - left;
    const xAt = (ms: number) => left + (ms / (total || 1)) * trackW;
    const yAt = (d: number) => base - d * (trackH - 8); // headroom above 100% for the playhead
    const niceSteps = [0.1, 0.2, 0.25, 0.5, 1, 2, 5];
    const tickS = niceSteps.find((t) => total / 1000 / t <= 6) ?? 5;
    const minorS = tickS / 5;
    g.strokeStyle = color.grid;
    g.lineWidth = 1;
    for (let t = minorS; t < total / 1000; t += minorS) {
      const gx = Math.round(xAt(t * 1000)) + 0.5;
      g.beginPath();
      g.moveTo(gx, trackTop);
      g.lineTo(gx, base);
      g.stroke();
    }
    hline(left, right, yAt(args.blankShare), color.rule);
    text(
      `${Math.round(args.blankShare * 100)}%`,
      left - 4,
      yAt(args.blankShare) + 3,
      mono,
      9,
      400,
      color.graphite,
      'right',
    );

    // One step per frame: from this frame's time to the next frame's (the last runs to the end).
    const steps = args.drawn.map((d, j) => ({
      d,
      x0: xAt(args.timesMs[j]!),
      x1: xAt(j + 1 < n ? args.timesMs[j + 1]! : total),
      played: j <= i,
      blank: d < args.blankShare,
    }));
    for (const st of steps) {
      g.fillStyle = !st.played
        ? 'rgba(0, 0, 0, 0.03)'
        : st.blank
          ? 'rgba(217, 45, 32, 0.14)'
          : 'rgba(17, 17, 17, 0.08)';
      g.fillRect(st.x0, yAt(st.d), Math.max(0.5, st.x1 - st.x0), base - yAt(st.d));
    }
    g.lineWidth = 1.5;
    g.lineJoin = 'miter';
    for (let j = 0; j < n; j++) {
      const st = steps[j]!;
      g.strokeStyle = !st.played ? color.future : st.blank ? color.blank : color.ink;
      g.beginPath();
      if (j > 0) g.moveTo(st.x0, yAt(steps[j - 1]!.d));
      else g.moveTo(st.x0, yAt(st.d));
      g.lineTo(st.x0, yAt(st.d));
      g.lineTo(st.x1, yAt(st.d));
      g.stroke();
    }
    hline(left, right, base, color.ink);

    // Time ruler: labelled major ticks, short minor ticks between them.
    g.strokeStyle = color.ink;
    g.lineWidth = 1;
    for (let t = 0; t <= total / 1000 + 1e-9; t += minorS) {
      const major = Math.abs(t / tickS - Math.round(t / tickS)) < 1e-6;
      const tx = Math.round(xAt(t * 1000)) + 0.5;
      g.strokeStyle = major ? color.ink : color.rule;
      g.beginPath();
      g.moveTo(tx, base);
      g.lineTo(tx, base + (major ? 5 : 3));
      g.stroke();
      if (major)
        text(
          `${Number(t.toFixed(2))}s`,
          tx,
          base + 17,
          mono,
          9,
          400,
          color.graphite,
          t === 0 ? 'left' : 'center',
        );
    }

    // Playhead: a line with a downward triangle, as in a video editor, and a dot where it meets
    // the trace.
    const headX = Math.round(xAt(args.timesMs[i]!)) + 0.5;
    g.strokeStyle = color.ink;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(headX, trackTop - 4);
    g.lineTo(headX, base);
    g.stroke();
    g.fillStyle = color.ink;
    g.beginPath();
    g.moveTo(headX - 4, trackTop - 9);
    g.lineTo(headX + 4, trackTop - 9);
    g.lineTo(headX, trackTop - 3);
    g.closePath();
    g.fill();
    g.beginPath();
    g.arc(headX, yAt(drawn), 3.5, 0, Math.PI * 2);
    g.fillStyle = blank ? color.blank : color.ink;
    g.fill();
    g.strokeStyle = color.paper;
    g.lineWidth = 1.5;
    g.stroke();

    const footY = base + 36;
    hline(left, right, footY - 14, color.rule);
    text(
      `${blankCount} of ${n} frames blank`,
      left,
      footY,
      sans,
      11,
      500,
      blankCount ? color.blank : color.graphite,
    );
    text(
      `frames under the ${Math.round(args.blankShare * 100)}% line are blank`,
      right,
      footY,
      sans,
      11,
      400,
      color.graphite,
      'right',
    );

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
      meter: process.env.SMOOTHNESS_REPLAY_METER === '1', // temporary, for comparing designs
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
