// Turns a measured run's trace screenshots into a WebM replay: each frame with the frame rate and
// other stats, a chart of the whole run, and a marker on frames where a list's rows weren't drawn.
import type { PageDriver, ScratchPage } from '../driver.js';
import { FORMAT_NAME } from '../constants.js';
import { muxWebM, type EncodedFrame } from './webm.js';
import { ARCHIVO } from './font.js';

/** Replays play this many times slower than real time: at 60fps, blank frames flash past unseen. */
const REPLAY_SLOWDOWN = 4;
/** A key frame this often, so the report's player can seek. */
const KEY_FRAME_EVERY = 30;
const REPLAY_BITRATE = 2_000_000;

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

const FRAME_MS = 1000 / 60;
const LABEL_HITCH_MS = 50;

export interface Hitch {
  startMs: number;
  endMs: number;
}

export function findHitches(frames: { tMs: number; dropped: boolean }[]): Hitch[] {
  const sorted = [...frames].sort((a, b) => a.tMs - b.tMs);
  const hitches: Hitch[] = [];
  let lastShown: number | null = null;
  let firstDropped: number | null = null;
  let lastDropped = 0;
  for (const f of sorted) {
    if (f.dropped) {
      firstDropped ??= f.tMs;
      lastDropped = f.tMs;
      continue;
    }
    if (firstDropped !== null) {
      hitches.push({ startMs: startOf(lastShown, firstDropped), endMs: f.tMs });
      firstDropped = null;
    }
    lastShown = f.tMs;
  }
  if (firstDropped !== null) {
    hitches.push({ startMs: startOf(lastShown, firstDropped), endMs: lastDropped + FRAME_MS });
  }
  return hitches;
}

function startOf(lastShown: number | null, firstDropped: number): number {
  return Math.max(lastShown ?? -Infinity, firstDropped - FRAME_MS);
}

/** Renders and encodes in the page. Self-contained: it's serialized into the browser. */
async function renderInPage(
  args: ReplayInput & {
    hitches: Hitch[];
    labelHitchMs: number;
    slowdown: number;
    keyEvery: number;
    bitrate: number;
    fonts: { weight: number; woff2: string }[];
  },
) {
  const bytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  // The panel's font, loaded from the package, so it looks the same on every machine.
  for (const f of args.fonts) {
    const face = new FontFace('Archivo', bytes(f.woff2), { weight: String(f.weight) });
    document.fonts.add(await face.load());
  }
  const decode = (b64: string) => createImageBitmap(new Blob([bytes(b64)], { type: 'image/jpeg' }));
  const first = await decode(args.jpegs[0]!);
  // The panel is laid out for a recording this wide, and a wider recording scales it up with it,
  // so it keeps its proportions. Everything below is in these layout units.
  const PANEL_WIDTH = 500;
  const scale = Math.max(1, first.width / PANEL_WIDTH);
  const imgW = first.width / scale;
  const imgH = first.height / scale;
  first.close();
  const n = args.jpegs.length;
  const total = args.timesMs[n - 1] ?? 0;
  // Frames count as blank (rows not drawn) only on a virtualized list.
  const rowsMatter = args.rect !== null && args.virtualized;

  const pad = 24;
  const even = (v: number) => Math.ceil(v) + (Math.ceil(v) % 2);
  const width = even(imgW + pad * 2);
  // A title row above the recording, and the frame rate and its chart below it.
  const shotTop = pad + 34;
  const height = even(shotTop + imgH + 30 + 60 + 44);
  const sx = imgW / args.viewport.width;
  const sy = imgH / args.viewport.height;
  const sans = 'Archivo, sans-serif';
  const c = {
    paper: '#ffffff',
    ink: '#0a0a0a',
    muted: '#666666',
    faint: '#a1a1a1',
    hair: '#eaeaea',
    wash: '#f5f5f5',
    // The one colour: the frame rate below 60.
    bad: '#b4413a',
  };

  const canvas = new OffscreenCanvas(even(width * scale), even(height * scale));
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
  // Numbers are set a little tighter than the font's default spacing, more so at display sizes,
  // where the default gaps between digits look loose.
  const tracking = (size: number) => size * (size >= 40 ? -0.04 : size >= 20 ? -0.03 : 0);
  const numWidth = (s: string, size: number, weight: number) => {
    g.font = `${weight} ${size}px ${sans}`;
    const cell = g.measureText('0').width + tracking(size);
    return [...s].reduce((w, ch) => w + (isDigit(ch) ? cell : g.measureText(ch).width + tracking(size)), 0);
  };
  const num = (
    s: string,
    x: number,
    y: number,
    { size = 12, weight = 400, fill = c.muted, align = 'left' as 'left' | 'right' } = {},
  ) => {
    const w = numWidth(s, size, weight);
    const cell = g.measureText('0').width + tracking(size);
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
        cx += g.measureText(ch).width + tracking(size);
      }
    }
    return w;
  };
  const fit = (s: string, max: number) => {
    if (g.measureText(s).width <= max) return s;
    while (s.length > 1 && g.measureText(s + '…').width > max) s = s.slice(0, -1);
    return s + '…';
  };
  const secs = (ms: number) => `${(ms / 1000).toFixed(2)}s`;

  // The list on the screenshot: a hairline when drawn; when its rows aren't drawn (a blank frame),
  // a black outline and a tag that says so. The empty list itself is the evidence, so it isn't
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
    g.strokeStyle = c.ink;
    g.lineWidth = 2;
    g.beginPath();
    g.roundRect(x + 1, y + 1, w - 2, h - 2, 4);
    g.stroke();
    g.font = `500 11px ${sans}`;
    const tag = 'Blank: rows not rendered yet';
    const tagW = g.measureText(tag).width + 16;
    g.fillStyle = c.ink;
    g.beginPath();
    g.roundRect(x + 8, y + 8, tagW, 20, 4);
    g.fill();
    text(tag, x + 16, y + 22, { size: 11, weight: 500, fill: c.paper });
  };

  const markFrozen = (ox: number, oy: number, ms: number) => {
    g.font = `500 11px ${sans}`;
    const tag = `Frozen ${Math.round(ms)}ms`;
    const tagW = numWidth(tag, 11, 500) + 16;
    const x = ox + imgW - 8 - tagW;
    g.fillStyle = c.bad;
    g.beginPath();
    g.roundRect(x, oy + 8, tagW, 20, 4);
    g.fill();
    num(tag, x + 8, oy + 22, { size: 11, weight: 500, fill: c.paper });
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
  const GRAPH_COLS = 60;
  const colOf = (ms: number) => Math.min(GRAPH_COLS - 1, Math.floor((ms / (total || 1)) * GRAPH_COLS));
  const slices = Array.from({ length: GRAPH_COLS }, (_, cI) => {
    const from = (cI / GRAPH_COLS) * total;
    const to = ((cI + 1) / GRAPH_COLS) * total;
    const mid = (from + to) / 2;
    return {
      fps: fpsBetween(Math.max(0, mid - FPS_WINDOW_MS / 2), Math.min(total, mid + FPS_WINDOW_MS / 2)),
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
  encoder.configure({
    codec: 'vp8',
    width: canvas.width,
    height: canvas.height,
    bitrate: args.bitrate,
    framerate: 60 / args.slowdown,
  });

  for (let i = 0; i < n; i++) {
    const img = await decode(args.jpegs[i]!);
    const now = args.timesMs[i]!;
    const next = args.timesMs[i + 1] ?? now + 1000 / 60;
    const drawn = args.drawn[i]!;
    const blank = rowsMatter && drawn < args.blankShare;
    const frozen = args.hitches.find(
      (h) => h.endMs - h.startMs >= args.labelHitchMs && h.startMs < next && h.endMs > now,
    );
    g.setTransform(scale, 0, 0, scale, 0, 0);
    g.fillStyle = c.paper;
    g.fillRect(0, 0, width, height);

    // The screenshot, in a rounded frame.
    g.save();
    g.beginPath();
    g.roundRect(pad, shotTop, imgW, imgH, 8);
    g.clip();
    g.drawImage(img, pad, shotTop, imgW, imgH);
    markList(pad, shotTop, blank);
    if (frozen) markFrozen(pad, shotTop, frozen.endMs - frozen.startMs);
    g.restore();
    img.close();
    g.strokeStyle = c.hair;
    g.lineWidth = 1;
    g.beginPath();
    g.roundRect(pad - 0.5, shotTop - 0.5, imgW + 1, imgH + 1, 8.5);
    g.stroke();

    const left = pad;
    const right = width - pad;
    // The frame rate and its chart sit right under the recording.
    const y = shotTop + imgH;

    const fps = fpsAt(now);
    const droppingNow = droppedBetween(now - FPS_WINDOW_MS, now) > 0;

    // Frame rate, large, beside the chart that plots it.
    const chartTop = y + 30;
    const chartH = 60;
    const chartBottom = chartTop + chartH;
    // The frame rate block spans the chart's axis labels: the label's capitals start level with the
    // top of the '60', and the number and 'fps' share the '0' label's baseline. The number is sized
    // to fill the height between, 9px below the label's baseline.
    const ascent = (font: string, ch: string) => {
      g.font = font;
      return g.measureText(ch).actualBoundingBoxAscent;
    };
    const axisTop = chartTop + 4 - ascent(`400 10px ${sans}`, '6');
    const labelBaseline = axisTop + ascent(`400 12px ${sans}`, 'F');
    const fpsBaseline = chartBottom + 4;
    const fpsSize = ((fpsBaseline - labelBaseline - 9) / ascent(`600 100px ${sans}`, '0')) * 100;
    // The label is spaced out to the ink width of two digits, and the digits' ink starts at the
    // label's left edge, so the two read as one block.
    g.font = `600 ${fpsSize}px ${sans}`;
    const zero = g.measureText('0');
    const bearing = (zero.width - zero.actualBoundingBoxLeft - zero.actualBoundingBoxRight) / 2;
    const digitsInk = numWidth('00', fpsSize, 600) - 2 * bearing;
    g.font = `400 12px ${sans}`;
    const label = 'Frame rate';
    const labelInk = g.measureText(label).actualBoundingBoxRight + g.measureText(label).actualBoundingBoxLeft;
    g.letterSpacing = `${Math.max(0, (digitsInk - labelInk) / (label.length - 1))}px`;
    text(label, left, labelBaseline, { fill: c.muted });
    g.letterSpacing = '0px';
    const fpsX = left - bearing;
    const fpsWidth = num(fps === null ? '–' : String(fps).padStart(2, '0'), fpsX, fpsBaseline, {
      size: fpsSize,
      weight: 600,
      fill: droppingNow ? c.bad : c.ink,
    });
    text('fps', fpsX + fpsWidth + 4, fpsBaseline, { size: 11, fill: c.faint });

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
      text(String(v), gl - 6, yAt(v) + 4, { size: 10, fill: c.faint, align: 'right' });
    }
    g.setLineDash([]);
    g.fillStyle = 'rgba(180, 65, 58, 0.07)';
    for (const h of args.hitches) {
      if (h.startMs > now) continue;
      const x0 = xAt(h.startMs);
      const x1 = xAt(Math.min(h.endMs, now));
      g.fillRect(x0, chartTop, Math.max(1.5, x1 - x0), chartH);
    }
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

    // The chart's time axis: the elapsed time, in real time, under the playhead.
    const elapsed = secs(now);
    g.font = `400 11px ${sans}`;
    const half = numWidth(elapsed, 11, 400) / 2;
    num(elapsed, Math.min(right - half, Math.max(gl + half, hx)) - half, chartBottom + 18, {
      size: 11,
      fill: c.muted,
    });

    // Above the recording: what was measured, and the video's own speed as a play icon and a
    // multiplier (the recording is slowed down so dropped and blank frames can be seen).
    const titleY = pad + 13;
    const speed = `${1 / args.slowdown}×`;
    g.font = `400 12px ${sans}`;
    const speedW = g.measureText(speed).width + 13;
    g.font = `500 13px ${sans}`;
    text(fit(args.title, right - left - speedW - 24), left, titleY, { size: 13, weight: 500, fill: c.ink });
    text(speed, right, titleY, { fill: c.faint, align: 'right' });
    const px = right - speedW;
    g.fillStyle = c.faint;
    g.beginPath();
    g.moveTo(px, titleY - 9);
    g.lineTo(px + 8, titleY - 4.5);
    g.lineTo(px, titleY);
    g.closePath();
    g.fill();

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
  return { width: canvas.width, height: canvas.height, chunks, failure };
}

/**
 * Encodes a replay in a throwaway page of the same Chromium (no dependency). Returns the WebM
 * bytes, or a reason it couldn't be made.
 */
export async function encodeReplay(
  page: PageDriver,
  input: ReplayInput,
): Promise<Uint8Array | { unavailable: string }> {
  if (input.jpegs.length === 0) return { unavailable: 'no frames to replay' };
  let scratch: ScratchPage | null = null;
  try {
    // WebCodecs needs a secure context, so the scratch page is on http://localhost.
    const opened = page.openScratchPage({ secure: true });
    if (!opened) return { unavailable: "the browser can't open a scratch page to encode the replay in" };
    scratch = await opened;
    if (!(await scratch.evaluate(() => typeof VideoEncoder !== 'undefined'))) {
      return { unavailable: "this browser has no WebCodecs VideoEncoder, so replays can't be encoded" };
    }
    const out = await scratch.evaluate(renderInPage, {
      ...input,
      hitches: findHitches(input.frames),
      labelHitchMs: LABEL_HITCH_MS,
      slowdown: REPLAY_SLOWDOWN,
      keyEvery: KEY_FRAME_EVERY,
      bitrate: REPLAY_BITRATE,
      fonts: ARCHIVO,
    });
    if (out.failure) return { unavailable: `the replay couldn't be encoded: ${out.failure}` };
    const frames: EncodedFrame[] = out.chunks
      .sort((a, b) => a.timeMs - b.timeMs)
      .map((c) => ({ timeMs: c.timeMs, key: c.key, data: Uint8Array.from(Buffer.from(c.data, 'base64')) }));
    if (!frames[0]?.key) return { unavailable: "the replay's first frame wasn't a key frame" };
    return muxWebM(frames, out.width, out.height, FORMAT_NAME);
  } catch (err) {
    return { unavailable: `the replay couldn't be made: ${String(err).split('\n')[0]}` };
  } finally {
    await scratch?.close().catch(() => undefined);
  }
}
