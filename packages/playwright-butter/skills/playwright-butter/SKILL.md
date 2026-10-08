---
name: playwright-butter
description: Fix a smoothness regression caught by playwright-butter, such as a fix brief (a .fix.md file or a "Fix brief" pasted from a pull request), a toBeSmooth() failure or smoothness-warning, slow input-to-paint, long animation frames, dropped frames, or blank frames in a scrolled list. Use it when asked to make an interaction, scroll, animation or drag smooth again.
---

# Fix a smoothness regression

playwright-butter measures an interaction or a scroll in Chromium and compares it with a baseline. When a check gets worse, it writes a fix brief: what got worse, the code behind it, and the commands to check a fix. This skill turns a brief into a fix and proves the fix worked.

## 1. Find the brief

- It may have been pasted into the conversation from a pull request comment.
- Otherwise look for `*.fix.md` files under the Playwright output folder (`test-results` by default), or collect them all with `npx playwright-butter brief --results test-results`.
- With no brief at all, run the failing test (the brief's "Check a fix" commands show how). A check that got worse writes one.

## 2. Read what got worse

"What got worse" names the number to move. Each points at a different kind of problem:

| Number                 | What it means                                                                                       | Usual cause                                                         |
| ---------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| input-to-paint (p95)   | Time from a click, tap or key press to the next frame on screen.                                    | The event handler, or what it triggers, does too much before paint. |
| long frames            | Frames that took over 50ms.                                                                         | One big piece of script or layout in a frame.                       |
| frames on time         | Frames that made their deadline, out of those with something to show. Catches drops under 50ms too. | Work repeated on every frame of a scroll, animation or drag.        |
| blank frames (list)    | Frames where a scrolled list was less than half drawn.                                              | Rows built too slowly, or not built ahead of the viewport.          |
| a budget (`budget: …`) | A fixed limit someone set, checked on every run.                                                    | Same as the number it limits.                                       |

## 3. Read where it happened

"Where" lists the starting points, most expensive first:

- **Slowest interactions**: which element and event was slow, such as `click on button#sort`.
- **Scripts in long frames**: the function, its file and line, and what ran it (an event listener, a `requestAnimationFrame` callback, a timer). With React and Angular this often names the framework's event dispatcher, not your code. The CPU profile below names the real function.
- **Where the CPU time went**: the functions that used the most CPU, with their callers. "itself" is the function's own time and "with what it called" includes its callees, so a function with high total and low self time is a caller: look at what it calls. The engine can also fold a small function into its caller, so a function's own time can belong to functions it calls. When the named function looks cheap on reading it, check what it calls.
- **Browser APIs that used time**: `getBoundingClientRect`, `offsetHeight`, `offsetTop`, `getComputedStyle` or `scrollTop` here almost always means forced layout (see the recipes). `innerHTML` or `appendChild` means a lot of DOM being built.
- **Frames** and **List** lines give the totals.

Locations are the paths the browser loaded, such as `/src/Filters.tsx:22` through a source map, `/assets/app.js:22`, or `/checkout/` for a script inside an HTML page. Map each one to the source file that the dev server or build serves at that path. A line number is where the function starts, not the slow line inside it, and a script inside an HTML page may have no line at all: search the page for the function's name.

Open each named function before deciding anything. The brief points at where the time went, which is not always where the change that caused it was made. Check `git log -p` on those files and their callers if the brief came from a pull request.

## 4. Record a baseline before changing anything

Baselines belong to the machine that recorded them, so CI's numbers can't be compared with this machine's. Run the first command from the brief's "Check a fix" on the **unchanged** code:

```bash
npx playwright test path/to/test.spec.ts:12 --update-snapshots=all
```

Note the numbers it prints for the check (they're also in the result JSON the brief names). Skipping this step leaves nothing to compare the fix with.

## 5. Make the fix

Match what the brief shows to a recipe in [references/recipes.md](references/recipes.md), then make the smallest change that takes the work off the frame or out of the handler. Keep what the user sees the same: the same content, the same order, the same end state. If the fix needs a visible change, such as a placeholder while rows load, say so in the summary.

Don't make a check pass by changing the measurement. These hide the problem rather than fix it:

- Raising `maxIncrease`, loosening or removing a `budget`, or switching `enforce` to `'warn'`
- Lowering `cpuThrottling` or `runs`, or switching the mode
- Running `--update-snapshots` to accept the slower numbers, or editing baseline files
- Changing the test so it does less, or skipping it

If the slowdown is the cost of a feature someone wants, stop and say so, with the numbers. Accepting it is their decision.

## 6. Check the fix

Run the second command from the brief, without updating:

```bash
npx playwright test path/to/test.spec.ts:12
```

The check now compares with the baseline from step 4. The brief also gives the baseline from CI. Numbers from a different machine won't match it exactly, but they should end up near it:

- **Barely moved:** the change missed the cause. Go back to step 3.
- **Better, but still far from the CI baseline** (twice it or more, or a number that hasn't moved): there's usually a second cause. The run's result JSON under `test-results/smoothness/` holds what the brief was made from: `input.byTarget` for the slowest interactions, `longFrames.topScripts` for the scripts, and `profile.hotFunctions` for where the CPU time went. What's in them now is what's left. Fix that too, or say clearly what's left and why you stopped.
- **A different number got worse:** the fix moved the work rather than removing it.
- **Every number that got worse is close to the CI baseline:** it's fixed.

Run the rest of the test file too, to catch a fix that breaks behaviour.

## 7. Clean up and report

- Leave out of the commit the baseline files steps 4 and 6 wrote. They're JSON files next to the test (in its `-snapshots` folder, named after the check's label) and describe this machine only. `git status` shows them; restore or delete them.
- Report what was slow and why, what changed, and the number before and after, such as "input-to-paint 212ms → 48ms on this machine (CI baseline 41ms)".
