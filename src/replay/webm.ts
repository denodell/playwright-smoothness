// A minimal WebM (Matroska) muxer for one VP8 video track: enough for browsers and the Playwright
// report to play and seek. Written here so replays need no dependency. Spec: https://www.matroska.org/technical/elements.html

export interface EncodedFrame {
  /** Presentation time in ms. */
  timeMs: number;
  key: boolean;
  data: Uint8Array;
}

const ID = {
  EBML: 0x1a45dfa3,
  EBMLVersion: 0x4286,
  EBMLReadVersion: 0x42f7,
  EBMLMaxIDLength: 0x42f2,
  EBMLMaxSizeLength: 0x42f3,
  DocType: 0x4282,
  DocTypeVersion: 0x4287,
  DocTypeReadVersion: 0x4285,
  Segment: 0x18538067,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  MuxingApp: 0x4d80,
  WritingApp: 0x5741,
  Duration: 0x4489,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackUID: 0x73c5,
  TrackType: 0x83,
  CodecID: 0x86,
  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  Cluster: 0x1f43b675,
  Timecode: 0xe7,
  SimpleBlock: 0xa3,
  Cues: 0x1c53bb6b,
  CuePoint: 0xbb,
  CueTime: 0xb3,
  CueTrackPositions: 0xb7,
  CueTrack: 0xf7,
  CueClusterPosition: 0xf1,
} as const;

/** An element ID's bytes (IDs already include their length marker). */
function idBytes(id: number): number[] {
  const out: number[] = [];
  for (let v = id; v > 0; v = Math.floor(v / 256)) out.unshift(v % 256);
  return out;
}

/** An EBML variable-length size. */
export function vint(n: number): number[] {
  for (let len = 1; len <= 8; len++) {
    if (n < 2 ** (7 * len) - 1) {
      const out: number[] = [];
      let v = n;
      for (let i = 0; i < len; i++) {
        out.unshift(v % 256);
        v = Math.floor(v / 256);
      }
      out[0]! |= 1 << (8 - len);
      return out;
    }
  }
  throw new Error(`size too large for EBML: ${n}`);
}

function uint(n: number): number[] {
  const out: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) out.unshift(v % 256);
  return out.length ? out : [0];
}

function float64(x: number): number[] {
  const b = new DataView(new ArrayBuffer(8));
  b.setFloat64(0, x);
  return [...new Uint8Array(b.buffer)];
}

const text = (s: string) => [...new TextEncoder().encode(s)];

type Part = number[] | Uint8Array;
function element(id: number, ...body: Part[]): Uint8Array {
  const size = body.reduce((a, p) => a + p.length, 0);
  const head = [...idBytes(id), ...vint(size)];
  const out = new Uint8Array(head.length + size);
  out.set(head, 0);
  let o = head.length;
  for (const p of body) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** A new cluster starts at every key frame, and before a block's relative time would overflow. */
const MAX_BLOCK_OFFSET_MS = 32_767;

export function muxWebM(frames: EncodedFrame[], width: number, height: number, app: string): Uint8Array {
  const header = element(
    ID.EBML,
    element(ID.EBMLVersion, [1]),
    element(ID.EBMLReadVersion, [1]),
    element(ID.EBMLMaxIDLength, [4]),
    element(ID.EBMLMaxSizeLength, [8]),
    element(ID.DocType, text('webm')),
    element(ID.DocTypeVersion, [2]),
    element(ID.DocTypeReadVersion, [2]),
  );
  const last = frames[frames.length - 1];
  const info = element(
    ID.Info,
    element(ID.TimecodeScale, uint(1_000_000)), // 1ms
    element(ID.MuxingApp, text(app)),
    element(ID.WritingApp, text(app)),
    element(ID.Duration, float64(last ? last.timeMs + 1 : 0)),
  );
  const tracks = element(
    ID.Tracks,
    element(
      ID.TrackEntry,
      element(ID.TrackNumber, [1]),
      element(ID.TrackUID, [1]),
      element(ID.TrackType, [1]), // video
      element(ID.CodecID, text('V_VP8')),
      element(ID.Video, element(ID.PixelWidth, uint(width)), element(ID.PixelHeight, uint(height))),
    ),
  );

  // Clusters, remembering where each starts (relative to the segment's data) for the cues.
  const clusters: Uint8Array[] = [];
  const cues: { time: number; position: number }[] = [];
  let offset = info.length + tracks.length;
  let i = 0;
  while (i < frames.length) {
    const start = frames[i]!.timeMs;
    const blocks: Uint8Array[] = [];
    do {
      const f = frames[i]!;
      const rel = Math.round(f.timeMs - start);
      blocks.push(
        element(ID.SimpleBlock, [0x81, (rel >> 8) & 0xff, rel & 0xff, f.key ? 0x80 : 0x00], f.data),
      );
      i++;
    } while (i < frames.length && !frames[i]!.key && frames[i]!.timeMs - start <= MAX_BLOCK_OFFSET_MS);
    const cluster = element(ID.Cluster, element(ID.Timecode, uint(Math.round(start))), ...blocks);
    cues.push({ time: Math.round(start), position: offset });
    clusters.push(cluster);
    offset += cluster.length;
  }
  const cueElement = element(
    ID.Cues,
    ...cues.map((c) =>
      element(
        ID.CuePoint,
        element(ID.CueTime, uint(c.time)),
        element(
          ID.CueTrackPositions,
          element(ID.CueTrack, [1]),
          element(ID.CueClusterPosition, uint(c.position)),
        ),
      ),
    ),
  );
  const segment = element(ID.Segment, info, tracks, ...clusters, cueElement);
  const out = new Uint8Array(header.length + segment.length);
  out.set(header, 0);
  out.set(segment, header.length);
  return out;
}
