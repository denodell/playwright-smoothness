// How much of a list is drawn in one frame. Also runs in the browser (serialized with
// toString), so it must stay self-contained: no imports and no outside references.

export interface CoverageOptions {
  /** 'vertical' scrolling measures pixel rows; 'horizontal' measures pixel columns. */
  direction: 'vertical' | 'horizontal';
  /** Colours that count as blank (the list background and any placeholders), as [r, g, b]. */
  blank: [number, number, number][];
  /** Largest per-channel difference that still matches a blank colour (JPEG noise). */
  tolerance: number;
  /** A line has content when at least this share of its pixels (and at least 2) isn't blank. */
  minContentShare: number;
}

/**
 * The share of lines (pixel rows for vertical scrolling) that contain content. Rows in a list
 * are mostly background even when drawn (padding, gaps, a row's own white fill), so counting
 * background pixels says little. A drawn row has content on most of its lines; a blank area
 * has none. For the test list, a drawn row has content on 70 of its 80 lines (87.5%).
 */
export function lineCoverage(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  o: CoverageOptions,
): number {
  const vertical = o.direction === 'vertical';
  const lines = vertical ? height : width;
  const along = vertical ? width : height;
  if (lines === 0 || along === 0) return 0;
  const needed = Math.max(2, Math.ceil(along * o.minContentShare));
  let withContent = 0;
  for (let l = 0; l < lines; l++) {
    let content = 0;
    for (let a = 0; a < along && content < needed; a++) {
      const i = 4 * (vertical ? l * width + a : a * width + l);
      const r = rgba[i]!;
      const g = rgba[i + 1]!;
      const b = rgba[i + 2]!;
      let isBlank = false;
      for (const c of o.blank) {
        if (
          Math.abs(r - c[0]) <= o.tolerance &&
          Math.abs(g - c[1]) <= o.tolerance &&
          Math.abs(b - c[2]) <= o.tolerance
        ) {
          isBlank = true;
          break;
        }
      }
      if (!isBlank) content++;
    }
    if (content >= needed) withContent++;
  }
  return withContent / lines;
}
