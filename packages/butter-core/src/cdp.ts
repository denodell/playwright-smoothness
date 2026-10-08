import type { CdpSession, PageDriver } from './driver.js';

const SCREENCAST_QUALITY = 80;

export interface ScreencastFrames {
  /** Base64 JPEGs, in order. */
  jpegs: string[];
  /** When each frame was shown, in ms since the epoch (the page's timeOrigin clock). */
  epochMs: number[];
}

export interface Screencast {
  stop(): Promise<ScreencastFrames>;
}

/** A CDP session for one page, with the throttling calls the runner needs. */
export class PageCdp {
  private constructor(private readonly session: CdpSession) {}

  static async open(page: PageDriver): Promise<PageCdp> {
    return new PageCdp(await page.cdp());
  }

  /**
   * Slows the page's CPU. Re-applied before every run, because a reload can move the page to
   * a new renderer process. https://chromedevtools.github.io/devtools-protocol/tot/Emulation/#method-setCPUThrottlingRate
   */
  async throttle(rate: number): Promise<void> {
    await this.session.send('Emulation.setCPUThrottlingRate', { rate });
  }

  /**
   * Records the page's frames as JPEGs, at up to `size` CSS pixels, until `stop()` is called. For
   * replays: a trace's screenshots are too small for a desktop-sized page (Chrome fits them in
   * 250px or 500px, depending on the version). Each frame must be acknowledged before Chrome sends
   * the next. https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-startScreencast
   */
  async screencast(size: { width: number; height: number }): Promise<Screencast> {
    const frames: ScreencastFrames = { jpegs: [], epochMs: [] };
    const onFrame = (e: { data: string; sessionId: number; metadata?: { timestamp?: number } }) => {
      frames.jpegs.push(e.data);
      // The frame's swap time, in seconds since the epoch. When Chrome leaves it out, the time it arrived.
      frames.epochMs.push(e.metadata?.timestamp !== undefined ? e.metadata.timestamp * 1000 : Date.now());
      this.session.send('Page.screencastFrameAck', { sessionId: e.sessionId }).catch(() => undefined);
    };
    this.session.on('Page.screencastFrame', onFrame);
    await this.session.send('Page.startScreencast', {
      format: 'jpeg',
      quality: SCREENCAST_QUALITY,
      maxWidth: Math.round(size.width),
      maxHeight: Math.round(size.height),
      everyNthFrame: 1,
    });
    return {
      stop: async () => {
        await this.session.send('Page.stopScreencast').catch(() => undefined);
        this.session.off('Page.screencastFrame', onFrame);
        return frames;
      },
    };
  }

  async close(): Promise<void> {
    await this.session.send('Emulation.setCPUThrottlingRate', { rate: 1 }).catch(() => undefined);
    await this.session.detach().catch(() => undefined);
  }
}
