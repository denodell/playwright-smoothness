import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const out = process.env.COVERAGE_PAGE_DIR;

if (out) {
  const require = createRequire(join(process.cwd(), 'package.json'));
  let core;
  try {
    core = require('playwright-core');
  } catch {
    core = null;
  }
  if (core) patch(core);
}

let written = 0;

async function collect(page) {
  if (!page.__smoothnessCoverage) return;
  page.__smoothnessCoverage = false;
  let entries;
  try {
    entries = await page.coverage.stopJSCoverage();
  } catch {
    return;
  }
  const scripts = entries
    .filter((e) => e.source && !/^https?:/.test(e.url))
    .map((e) => ({ source: e.source, functions: e.functions }));
  if (scripts.length) {
    writeFileSync(join(out, `page-${process.pid}-${Date.now()}-${written++}.json`), JSON.stringify(scripts));
  }
}

async function start(page) {
  if (page.__smoothnessCoverage !== undefined || !page.coverage) return;
  page.__smoothnessCoverage = true;
  try {
    await page.coverage.startJSCoverage({ resetOnNavigation: false, reportAnonymousScripts: true });
  } catch {
    page.__smoothnessCoverage = false;
  }
}

function patch(core) {
  const patched = new WeakSet();
  const patchContext = (ctx) => {
    if (patched.has(ctx)) return;
    patched.add(ctx);
    ctx.on('page', (p) => void start(p));
    for (const p of ctx.pages()) void start(p);
    const proto = Object.getPrototypeOf(ctx);
    if (!patched.has(proto)) {
      patched.add(proto);
      const close = proto.close;
      proto.close = async function (...args) {
        await Promise.all(this.pages().map(collect));
        return close.apply(this, args);
      };
      const newPage = proto.newPage;
      proto.newPage = async function (...args) {
        const page = await newPage.apply(this, args);
        await start(page);
        const pageProto = Object.getPrototypeOf(page);
        if (!patched.has(pageProto)) {
          patched.add(pageProto);
          const pageClose = pageProto.close;
          pageProto.close = async function (...a) {
            await collect(this);
            return pageClose.apply(this, a);
          };
        }
        return page;
      };
    }
  };
  const patchBrowser = (browser) => {
    for (const ctx of browser.contexts()) patchContext(ctx);
    const proto = Object.getPrototypeOf(browser);
    if (patched.has(proto)) return;
    patched.add(proto);
    const newContext = proto.newContext;
    proto.newContext = async function (...args) {
      const ctx = await newContext.apply(this, args);
      patchContext(ctx);
      return ctx;
    };
    const close = proto.close;
    proto.close = async function (...args) {
      await Promise.all(this.contexts().flatMap((c) => c.pages().map(collect)));
      return close.apply(this, args);
    };
  };
  const chromium = core.chromium;
  const proto = Object.getPrototypeOf(chromium);
  const launch = proto.launch;
  proto.launch = async function (...args) {
    const browser = await launch.apply(this, args);
    if (this.name() === 'chromium') patchBrowser(browser);
    return browser;
  };
}
