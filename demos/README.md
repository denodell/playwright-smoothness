# Demo apps

Seven small apps, each with a fast version (`?v=good`) and a slow one (`?v=bad`), for checking that playwright-butter catches the kinds of problem real apps have. The README's replay GIFs come from two of them.

| App        | What it is                    | What the slow version does                                                         |
| ---------- | ----------------------------- | ---------------------------------------------------------------------------------- |
| `invoices` | A letterpress shop's invoices | Rebuilds the table on every keystroke and forces a layout for each row             |
| `kanban`   | A bakery's production board   | Re-renders 400 React cards without memoization when you sort                       |
| `parallax` | A coast road travel story     | Measures and moves every image on every scroll event                               |
| `drawer`   | A home energy monitor         | Rebuilds the usage chart on every frame of the panel's slide-in                    |
| `feed`     | A cycling club feed           | Builds each post slowly, with nothing built ahead of the viewport                  |
| `journal`  | A trail journal               | Takes over the mouse wheel and scrolls the page itself, with work on each frame    |
| `board`    | A design board, like Canva's  | Re-renders all 940 layers and measures each one for snapping on every pointer move |

The design board shows what full mode's frame timeline adds. Its slow drag drops about a quarter of its frames while producing at most one long frame, so Long Animation Frames alone would barely register it. The drag test sends pointer moves every 16ms through CDP without waiting for the page, the way a mouse keeps moving whether or not the page keeps up.

## Run them

From the repository root, after `npm run build`:

```bash
APP_VARIANT=good npx playwright test -c demos
```

```bash
APP_VARIANT=bad npx playwright test -c demos
```

The first run records baselines on your machine and the second compares the slow versions with them. The slow runs take about 10 minutes, most of it the invoice search. `demos/server.mjs` serves the apps on http://localhost:4300 if you want to open them yourself.

## The agent skill, checked against them

The [agent skill](../README.md#the-agent-skill) was checked by giving each slow app to a coding agent (Claude) that had never seen it. Each app was copied into its own project with only the slow code, without the comments that describe the problem. The brief came from a run against a baseline recorded on the fast version, the way a pull request is compared with main. The agent got the brief, the project with the skill installed, and a request to fix it. Every fix was then measured again separately: a baseline on the slow code, then a run on the agent's change, on the same machine (2 CPUs, CPU slowed 4x, full mode).

| App      | What the agent changed                                                                                            | Before → after                                                              | Main's baseline |
| -------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | --------------- |
| drawer   | Built the chart once instead of on every frame, and moved the slide-in to `element.animate()`                     | frames on time 67% → 100%, input-to-paint 40ms → 16ms                       | 100%, 16ms      |
| kanban   | `memo` on the card and `useMemo` on its formatted description                                                     | input-to-paint 792ms → 200ms                                                | 160ms           |
| board    | Built the layers once and toggled only the highlights that changed; measured edges once when the drag starts      | long frames 4 → 0, frames on time 15% → 85%                                 | 0, 93%          |
| parallax | Hashed the text once, measured positions once, and moved images with `transform` once per frame                   | long frames 14 → 5, frames on time 93% → 99%                                | 5, 100%         |
| feed     | Replaced the per-post loop with a formula worked out once, and built three posts ahead of the viewport            | blank frames 93% → 0%, long frames 9 → 0, frames on time 81% → 100%         | 0%, 1, 100%     |
| journal  | Removed the stand-in work from the scroll loop and read every position before changing any class                  | long frames 24 → 0, frames on time 47% → 99%                                | 0, 100%         |
| invoices | Built the rows once and filtered by hiding them, with heights measured once instead of once per row per keystroke | input-to-paint 28,520ms → 464ms, long frames 4 → 2, frames on time 2% → 20% | 528ms, 2, 16%   |

None of the agents loosened a check, changed a test or accepted the slower numbers. Each one recorded a baseline on the unchanged code before changing anything, and left the baseline files out of its commit.

Three things came out of it:

- **The invoice agent stopped too early at first.** Its first fix removed the forced layout (input-to-paint 29,928ms → 744ms) but left the table being rebuilt on every keystroke, because the skill said a fix was done once it was clearly better than before. The skill now says to keep going while the numbers are still far from main's baseline. With that change a fresh agent fixed both causes, which is the result in the table.
- **The journal and feed stand-in work is too easy to remove.** Both demos stand in for real work with a loop whose result nothing uses (the feed's was changed to show its result for this check). The journal agent deleted its loop and left the scripted scrolling in place, and the feed agent worked the loop out as a formula. Both fixes are correct for these apps, but real code wouldn't allow either shortcut.
- **The agents kept what the user sees.** The board agent kept the highlight on nearby layers and the parallax agent kept the brightness effect and the reading progress, where the demos' own fast versions drop them.

## Regenerate the docs images

```bash
npm run docs:images
```

This rebuilds the two README GIFs from the journal and feed demos, and `docs/replay-frame.png` and `docs/hero.png` from the test pages. The GIFs need ImageMagick 7 (`magick`).
