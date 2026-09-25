// Framework check (M1): what LoAF attribution looks like when a framework sits between the
// browser and the app's handler. React delegates events to its root; Angular with Zone.js
// wraps every listener. Findings are written up in docs/frameworks.md.
import { test, expect } from '../../src/index.js';
import { save } from '../detection/helpers.js';

const PAGES = [
  'react.prod',
  'react.dev',
  'angular-zone.prod',
  'angular-zone.dev',
  'angular-zoneless.prod',
  'angular-zoneless.dev',
] as const;

for (const name of PAGES) {
  test(`attribution on ${name}`, async ({ page, smoothness }) => {
    await page.goto(`/frameworks/dist/${name}.html`);
    await page.locator('#checkout').waitFor();
    const click = await smoothness.measure(`${name} checkout`, () => page.click('#checkout .label'), {
      runs: 2,
    });
    const typing = await smoothness.measure(
      `${name} search`,
      async () => {
        await page.locator('#search').waitFor();
        await page.focus('#search');
        await page.keyboard.type('ab', { delay: 100 });
      },
      { runs: 2 },
    );
    save(`framework-${name}`, {
      click: {
        byTarget: click.input?.byTarget,
        longFrames: click.longFrames,
        unavailable: click.unavailable,
      },
      typing: {
        byTarget: typing.input?.byTarget,
        longFrames: typing.longFrames,
        unavailable: typing.unavailable,
      },
    });

    // Event Timing names the real element whatever the framework does.
    expect(click.input!.byTarget[0]!.target).toBe('button#checkout');
    expect(typing.input!.byTarget[0]!.target).toBe('input#search');
    // The work is seen, whoever gets the blame.
    expect(click.longFrames!.count).toBe(1);
    expect(click.longFrames!.worstMs!).toBeGreaterThanOrEqual(150);
    expect(typing.longFrames!.count).toBe(2);
    // Whatever the framework's dispatcher is called, the blamed script is linked to the element.
    expect(click.longFrames!.topScripts[0]!.during).toEqual(['click on button#checkout']);
    expect(typing.longFrames!.topScripts[0]!.during).toEqual(['keydown on input#search']);
  });
}

// Full mode's CPU profile names the app's handler behind each framework's dispatcher, which
// LoAF can't. In minified builds the names come back through the page's source maps.
for (const name of PAGES) {
  test(`CPU profile names onCheckout on ${name}`, async ({ page, smoothness }) => {
    await page.goto(`/frameworks/dist/${name}.html`);
    await page.locator('#checkout').waitFor();
    const result = await smoothness.measure(`${name} profile`, () => page.click('#checkout .label'), {
      mode: 'full',
      runs: 2,
    });
    const top = result.profile!.hotFunctions[0]!;
    save(`framework-profile-${name}`, { profile: result.profile, notes: result.notes });
    expect(top.selfMs).toBeGreaterThan(80);
    expect(top.fn).toBe('busyWait');
    expect(top.callers[0]).toBe('onCheckout');
    expect(top.url).toMatch(/\/frameworks\/src\/work\.js$/);
    // Every build here ships a source map, so the bundle position is kept alongside.
    expect(top.generated!.url).toMatch(new RegExp(`/frameworks/dist/${name.replace('.', '\\.')}\\.js$`));
    if (name.endsWith('.prod')) expect(top.generated!.fn).not.toBe('busyWait');
    // Only the page's own compositor is counted, so there's nothing to note.
    expect(result.notes).toEqual([]);
  });
}
