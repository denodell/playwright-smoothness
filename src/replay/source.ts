// The frames a replay would be made from, kept with a result until the test body has finished
// and toBeSmooth() has decided whether a replay is wanted. Not part of the JSON result.
import type { SmoothnessResult } from '../types.js';
import type { ReplayInput } from './encode.js';

const sources = new WeakMap<SmoothnessResult, ReplayInput>();

export function setReplaySource(result: SmoothnessResult, source: ReplayInput): void {
  sources.set(result, source);
}

/** Returns the frames and forgets them (several MB). */
export function takeReplaySource(result: SmoothnessResult): ReplayInput | undefined {
  const s = sources.get(result);
  sources.delete(result);
  return s;
}
