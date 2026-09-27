// Turns a measured run's trace screenshots into a WebM replay: each frame with the frame rate and
// other stats, a chart of the whole run, and a marker on frames where a list's rows weren't drawn.
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
  /** scroll() only: each frame's drawn share relative to the list at rest, 0..1. Empty otherwise. */
  drawn: number[];
  /** Below this share a frame is blank. */
  blankShare: number;
  /** The compositor's presented and dropped frames, in ms from the first screenshot. */
  frames: { tMs: number; dropped: boolean }[];
  /** measure() only: when each input arrived, and each long frame, in ms from the first screenshot. */
  markers: { inputs: number[]; longFrames: { tMs: number; durMs: number }[] };
  /** scroll() only: whether the list is virtualized, so blank frames mean rows that weren't built. */
  virtualized: boolean;
  /** scroll() only: the list's client area in CSS pixels, to outline it. Null for measure(). */
  rect: { x: number; y: number; width: number; height: number } | null;
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
  // Frames count as blank (rows not drawn) only on a virtualized list.
  const rowsMatter = args.rect !== null && args.virtualized;
  const blankCount = rowsMatter ? args.drawn.filter((d) => d < args.blankShare).length : 0;

  // What the strip under the graph shows: rows not drawn (virtualized lists), long frames
  // (measure()), or nothing (other scrolls).
  const strip: 'rows' | 'long' | null = args.rect === null ? 'long' : rowsMatter ? 'rows' : null;
  const pad = 24;
  const even = (v: number) => Math.ceil(v) + (Math.ceil(v) % 2);
  const width = even(imgW + pad * 2);
  // Room above the chart for a key, when there's something to key, and under it for the strip.
  const keyRoom = strip || args.markers.inputs.length ? 18 : 0;
  const height = even(pad + imgH + 48 + 28 + keyRoom + 60 + (strip ? 54 : 50) + 18);
  const sx = imgW / args.viewport.width;
  const sy = imgH / args.viewport.height;
  const sans =
    'Inter, Geist, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
  const c = {
    paper: '#ffffff',
    ink: '#0a0a0a',
    muted: '#666666',
    faint: '#a1a1a1',
    hair: '#eaeaea',
    wash: '#f5f5f5',
    bad: '#e5484d',
  };

  const canvas = new OffscreenCanvas(width, height);
  const g = canvas.getContext('2d')!;
  const text = (
    s: string,
    x: number,
    y: number,
    { size = 12, weight = 400, fill = c.muted, align = 'left' as CanvasTextAlign } = {},
  ) => {
    g.font = `${weight} ${size}px ${sans}`;
    g.fillStyle = fill;
    g.textAlign = align;
    g.fillText(s, x, y);
    return g.measureText(s).width;
  };
  // Numbers with every digit in a cell the width of a zero, like CSS's tabular-nums (canvas text
  // has no such setting), so a readout doesn't shift as its digits change. A figure space
  // (U+2007) is a blank digit.
  const isDigit = (ch: string) => (ch >= '0' && ch <= '9') || ch === '\u2007';
  const numWidth = (s: string, size: number, weight: number) => {
    g.font = `${weight} ${size}px ${sans}`;
    const cell = g.measureText('0').width;
    return [...s].reduce((w, ch) => w + (isDigit(ch) ? cell : g.measureText(ch).width), 0);
  };
  const num = (
    s: string,
    x: number,
    y: number,
    { size = 12, weight = 400, fill = c.muted, align = 'left' as 'left' | 'right' } = {},
  ) => {
    const w = numWidth(s, size, weight);
    const cell = g.measureText('0').width;
    g.fillStyle = fill;
    let cx = align === 'right' ? x - w : x;
    for (const ch of s) {
      if (isDigit(ch)) {
        g.textAlign = 'center';
        g.fillText(ch, cx + cell / 2, y);
        cx += cell;
      } else {
        g.textAlign = 'left';
        g.fillText(ch, cx, y);
        cx += g.measureText(ch).width;
      }
    }
    return w;
  };
  const fit = (s: string, max: number) => {
    if (g.measureText(s).width <= max) return s;
    while (s.length > 1 && g.measureText(s + '…').width > max) s = s.slice(0, -1);
    return s + '…';
  };
  const hline = (x0: number, x1: number, y: number, stroke = c.hair) => {
    g.fillStyle = stroke;
    g.fillRect(x0, Math.round(y), x1 - x0, 1);
  };
  const secs = (ms: number) => `${(ms / 1000).toFixed(2)}s`;

  // The list on the screenshot: a hairline when drawn; when its rows aren't drawn (a blank frame),
  // a red outline and a tag that says so. The empty list itself is the evidence, so it isn't
  // covered.
  const markList = (ox: number, oy: number, blank: boolean) => {
    if (!args.rect) return;
    const x = ox + args.rect.x * sx;
    const y = oy + args.rect.y * sy;
    const w = args.rect.width * sx;
    const h = args.rect.height * sy;
    if (!blank) {
      g.strokeStyle = 'rgba(10, 10, 10, 0.2)';
      g.lineWidth = 1;
      g.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
      return;
    }
    g.strokeStyle = c.bad;
    g.lineWidth = 2;
    g.beginPath();
    g.roundRect(x + 1, y + 1, w - 2, h - 2, 4);
    g.stroke();
    g.font = `500 11px ${sans}`;
    const tag = 'Rows not drawn yet';
    const tagW = g.measureText(tag).width + 16;
    g.fillStyle = c.bad;
    g.beginPath();
    g.roundRect(x + 8, y + 8, tagW, 20, 4);
    g.fill();
    text(tag, x + 16, y + 22, { size: 11, weight: 500, fill: c.paper });
  };

  // Frame rate over a short trailing window, from the compositor's presented frames.
  const FPS_WINDOW_MS = 250;
  const presented = args.frames.filter((f) => !f.dropped).map((f) => f.tMs);
  const droppedTimes = args.frames.filter((f) => f.dropped).map((f) => f.tMs);
  const countBetween = (times: number[], from: number, to: number) =>
    times.reduce((k, t) => (t > from && t <= to ? k + 1 : k), 0);
  const droppedBetween = (from: number, to: number) => countBetween(droppedTimes, from, to);
  // Frames per second while there's something to show: of the frames that had an update, the
  // share presented, at 60Hz. When nothing on screen changes, Chrome makes no new frames, and
  // that isn't a low frame rate, so it's null rather than zero.
  const fpsBetween = (from: number, to: number) => {
    const shown = countBetween(presented, from, to);
    const missed = countBetween(droppedTimes, from, to);
    return shown + missed === 0 ? null : Math.round((60 * shown) / (shown + missed));
  };
  const fpsAt = (t: number) => fpsBetween(t - FPS_WINDOW_MS, t);
  // One mark per interaction: its entries (pointerdown, click) arrive within a few ms.
  const inputs = [...args.markers.inputs]
    .sort((a, b) => a - b)
    .filter((t, k, all) => k === 0 || t - all[k - 1]! > 30);
  const GRAPH_COLS = 60;
  const colOf = (ms: number) => Math.min(GRAPH_COLS - 1, Math.floor((ms / (total || 1)) * GRAPH_COLS));
  const slices = Array.from({ length: GRAPH_COLS }, (_, cI) => {
    const from = (cI / GRAPH_COLS) * total;
    const to = ((cI + 1) / GRAPH_COLS) * total;
    const mid = (from + to) / 2;
    return {
      fps: fpsBetween(Math.max(0, mid - FPS_WINDOW_MS / 2), Math.min(total, mid + FPS_WINDOW_MS / 2)),
      blank: args.drawn.some((d, j) => d < args.blankShare && colOf(args.timesMs[j]!) === cI),
      long: args.markers.longFrames.some((f) => f.tMs < to && f.tMs + f.durMs > from),
    };
  });

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
    const now = args.timesMs[i]!;
    const drawn = args.drawn[i]!;
    const blank = rowsMatter && drawn < args.blankShare;
    g.fillStyle = c.paper;
    g.fillRect(0, 0, width, height);

    // The screenshot, in a rounded frame.
    g.save();
    g.beginPath();
    g.roundRect(pad, pad, imgW, imgH, 8);
    g.clip();
    g.drawImage(img, pad, pad);
    markList(pad, pad, blank);
    g.restore();
    img.close();
    g.strokeStyle = c.hair;
    g.lineWidth = 1;
    g.beginPath();
    g.roundRect(pad - 0.5, pad - 0.5, imgW + 1, imgH + 1, 8.5);
    g.stroke();

    const left = pad;
    const right = width - pad;
    let y = pad + imgH + 34;
    g.font = `500 13px ${sans}`;
    const speed = `Replay at 1/${args.slowdown} speed`;
    g.font = `400 12px ${sans}`;
    const speedW = g.measureText(speed).width;
    g.font = `500 13px ${sans}`;
    text(fit(args.title, right - left - speedW - 24), left, y, { size: 13, weight: 500, fill: c.ink });
    text(speed, right, y, { fill: c.faint, align: 'right' });
    y += 14;
    hline(left, right, y);

    const fps = fpsAt(now);
    const droppingNow = droppedBetween(now - FPS_WINDOW_MS, now) > 0;
    const droppedSoFar = droppedBetween(-1, now);

    // Above the chart, right-aligned: what the red in the strip means, and the input marks.
    const keyY = y + 24;
    let kx = right;
    const key = (label: string, detail: string, swatch: (x: number) => void) => {
      g.font = `400 12px ${sans}`;
      const w = g.measureText(label).width + (detail ? g.measureText(detail).width + 6 : 0);
      kx -= w;
      const tx = kx + text(label, kx, keyY, { fill: c.muted }) + 6;
      if (detail) text(detail, tx, keyY, { fill: c.faint });
      swatch(kx - 14);
      kx -= 30;
    };
    if (inputs.length)
      key('Input', '', (x) => {
        g.fillStyle = c.muted;
        g.beginPath();
        g.moveTo(x, keyY - 8);
        g.lineTo(x + 8, keyY - 8);
        g.lineTo(x + 4, keyY - 1);
        g.closePath();
        g.fill();
      });
    const square = (x: number) => {
      g.fillStyle = c.bad;
      g.beginPath();
      g.roundRect(x, keyY - 8, 8, 8, 2);
      g.fill();
    };
    if (strip === 'rows') key('Rows not drawn', `${blankCount} of ${n} frames`, square);
    if (strip === 'long') key('Long frames', String(args.markers.longFrames.length), square);

    // Frame rate, large, beside the chart that plots it.
    const chartTop = y + 28 + keyRoom;
    const chartH = 60;
    const chartBottom = chartTop + chartH;
    text('Frame rate', left, chartTop + 2, { fill: c.muted });
    num(fps === null ? '–' : String(fps), left - 2, chartTop + 48, {
      size: 44,
      weight: 600,
      fill: droppingNow ? c.bad : c.ink,
    });
    text('fps', left, chartTop + 66, { size: 13, fill: c.faint });

    // The frame rate across the run, drawn in as the replay plays: black at 60fps, red below
    // it, where frames were dropped. A gridline at 60 and 30.
    const axis = left + 104;
    const gl = axis + 22;
    const xAt = (ms: number) => gl + (ms / (total || 1)) * (right - gl);
    const yAt = (f: number) => chartBottom - (f / 60) * chartH;
    const sliceW = (right - gl) / GRAPH_COLS;
    for (const [v, dashed] of [
      [60, true],
      [30, true],
      [0, false],
    ] as const) {
      g.strokeStyle = c.hair;
      g.lineWidth = 1;
      g.setLineDash(dashed ? [3, 3] : []);
      g.beginPath();
      g.moveTo(gl, Math.round(yAt(v)) + 0.5);
      g.lineTo(right, Math.round(yAt(v)) + 0.5);
      g.stroke();
      text(String(v), axis, yAt(v) + 4, { size: 10, fill: c.faint });
    }
    g.setLineDash([]);
    const playCol = colOf(now);
    const pts: { x: number; y: number; ok: boolean }[] = [];
    for (let cI = 0; cI <= playCol; cI++) {
      const f = slices[cI]!.fps;
      if (f === null) continue;
      pts.push({ x: gl + (cI + 0.5) * sliceW, y: yAt(f), ok: f >= 58 });
    }
    g.lineWidth = 1.5;
    g.lineJoin = 'round';
    g.lineCap = 'round';
    for (let k = 1; k < pts.length; k++) {
      g.strokeStyle = pts[k]!.ok && pts[k - 1]!.ok ? c.ink : c.bad;
      g.beginPath();
      g.moveTo(pts[k - 1]!.x, pts[k - 1]!.y);
      g.lineTo(pts[k]!.x, pts[k]!.y);
      g.stroke();
    }
    // measure(): a small mark above the chart where each input arrived.
    for (const t of inputs) {
      if (t > now) continue;
      const ix = Math.round(xAt(Math.max(0, t))) + 0.5; // an input just before the first frame sits at the start
      g.fillStyle = c.muted;
      g.beginPath();
      g.moveTo(ix - 3.5, chartTop - 11);
      g.lineTo(ix + 3.5, chartTop - 11);
      g.lineTo(ix, chartTop - 5);
      g.closePath();
      g.fill();
    }
    // Playhead, with a dot at the current frame rate.
    const hx = Math.round(xAt(now)) + 0.5;
    g.fillStyle = 'rgba(10, 10, 10, 0.25)';
    g.fillRect(hx - 0.5, chartTop - 4, 1, chartBottom - chartTop + 4);
    const last = pts[pts.length - 1];
    if (last) {
      g.fillStyle = c.paper;
      g.strokeStyle = last.ok ? c.ink : c.bad;
      g.lineWidth = 1.5;
      g.beginPath();
      g.arc(hx, last.y, 3.5, 0, Math.PI * 2);
      g.fill();
      g.stroke();
    }

    // A strip under the chart marks slices with rows not drawn (virtualized lists) or long
    // frames (measure()).
    y = chartBottom;
    if (strip) {
      y += 10;
      g.fillStyle = c.wash;
      g.beginPath();
      g.roundRect(gl, y, right - gl, 6, 3);
      g.fill();
      g.fillStyle = c.bad;
      // Runs of marked slices, each drawn as one bar so there are no seams between them.
      const marked = (cI: number) =>
        cI <= playCol && (strip === 'rows' ? slices[cI]!.blank : slices[cI]!.long);
      for (let cI = 0; cI <= playCol; cI++) {
        if (!marked(cI)) continue;
        let end = cI;
        while (marked(end + 1)) end++;
        g.beginPath();
        g.roundRect(gl + cI * sliceW, y, (end - cI + 1) * sliceW, 6, 3);
        g.fill();
        cI = end;
      }
      y += 6;
    }

    // Under the chart, right-aligned: how much of the list was drawn (when it went blank),
    // dropped frames and elapsed time, each with its label over two lines to its left. The
    // frame number is on the left of the same line.
    const statY = strip ? y + 38 : y + 50;
    // Each value sits in a slot as wide as its largest value in the run, so labels stay put.
    const stats: { words: [string, string]; value: string; widest: string; bad?: boolean }[] = [];
    if (blankCount > 0)
      stats.push({
        words: ['List', 'drawn'],
        value: `${Math.round(drawn * 100)}%`,
        widest: '100%',
        bad: blank,
      });
    stats.push({
      words: ['Dropped', 'frames'],
      value: String(droppedSoFar),
      widest: String(droppedBetween(-1, total)),
      bad: droppedSoFar > 0,
    });
    stats.push({ words: ['Elapsed', 'time'], value: secs(now), widest: secs(total) });
    let sx2 = right;
    for (const st of [...stats].reverse()) {
      num(st.value, sx2, statY, { size: 22, weight: 600, fill: st.bad ? c.bad : c.ink, align: 'right' });
      const lx = sx2 - numWidth(st.widest, 22, 600) - 8;
      text(st.words[0], lx, statY - 12, { size: 11, fill: c.muted, align: 'right' });
      text(st.words[1], lx, statY, { size: 11, fill: c.muted, align: 'right' });
      g.font = `400 11px ${sans}`;
      sx2 = lx - Math.max(...st.words.map((word) => g.measureText(word).width)) - 24;
    }
    text('Frame', left, statY - 12, { size: 11, fill: c.muted });
    num(`${String(i + 1).padStart(String(n).length, '\u2007')} of ${n}`, left, statY, {
      size: 11,
      fill: c.faint,
    });

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
