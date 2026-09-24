# Attribution with frameworks

Brief M1 asks what Long Animation Frame (LoAF) attribution looks like when a framework sits between the browser and the app's event handler, and whether source maps are needed to name the app's function. This page records what `tests/integration/frameworks.spec.ts` measured.

## Setup

Three apps, each with a button whose click handler blocks for 150ms (`onCheckout`) and a search input whose keydown handler blocks for 60ms (`onSearchKey`). Each app is built twice with esbuild: `prod` (minified, as teams ship) and `dev` (readable names), both with source maps. Built by `scripts/build-test-pages.mjs`.

| App                     | How events reach the handler                                                                                   |
| ----------------------- | -------------------------------------------------------------------------------------------------------------- |
| React 19                | One listener per event type on the root container. React's dispatcher finds and calls the component's handler. |
| Angular 21 with Zone.js | Listeners on the elements themselves, each wrapped by Zone.js. This is how most existing Angular apps run.     |
| Angular 21 zoneless     | Listeners on the elements, called through Angular's own wrapper. The default for new Angular apps.             |

Angular is bootstrapped in JIT mode (no Angular CLI). JIT and AOT builds register listeners the same way (Angular's `listener` instruction and, with Zone.js, its patched `addEventListener`), so JIT shouldn't hide anything AOT would show. If a team reports otherwise, an AOT build is the next check.

## What LoAF reports

Chrome 153. Identical locally and on GitHub Actions (PR #2, run 35945190946):

| Page                    | LoAF `invoker`            | LoAF `sourceFunctionName`        | Event Timing target |
| ----------------------- | ------------------------- | -------------------------------- | ------------------- |
| React, dev              | `DIV#root.onclick`        | `dispatchDiscreteEvent`          | `button#checkout`   |
| React, prod             | `DIV#root.onclick`        | `QS` (minified)                  | `button#checkout`   |
| Angular + Zone.js, dev  | `BUTTON#checkout.onclick` | `globalZoneAwareCallback`        | `button#checkout`   |
| Angular + Zone.js, prod | `BUTTON#checkout.onclick` | `m` (minified)                   | `button#checkout`   |
| Angular zoneless, dev   | `BUTTON#checkout.onclick` | _(empty: an anonymous function)_ | `button#checkout`   |
| Angular zoneless, prod  | `BUTTON#checkout.onclick` | _(empty)_                        | `button#checkout`   |

The keydown results follow the same pattern (`DIV#root.onkeydown`, `INPUT#search.onkeydown`).

In every case LoAF measured the work correctly: one long frame of at least 150ms for the click, and one per key press. **But it never named `onCheckout` or `onSearchKey`.**

- **React** blames its own root listener and dispatcher. The invoker names the root container, not the button.
- **Zone.js** blames its wrapper. The invoker does name the right element, because Zone.js patches `addEventListener` on the element itself.
- **Zoneless Angular** blames an anonymous wrapper, so there's no function name at all.
- **Event Timing names the real element every time,** including through React's delegation.

## Why source maps don't fix this

LoAF's `scripts[]` records only the _entry point_ of each script execution: the function the browser called. The browser calls the framework's dispatcher, and the dispatcher calls the app's handler. So `sourceURL` and `sourceCharPosition` point at the dispatcher. A source map would turn `QS` back into `dispatchDiscreteEvent` in `react-dom`, but it can't name `onCheckout`, because that function is never an entry point.

So source-map resolution was **not** added. It would add a runtime dependency and network fetches for maps, and give only a nicer name for the framework's code.

## What the library does instead

Each entry in `longFrames.topScripts` has a `during` list: the interactions whose frames that script blocked, from Event Timing and the scroll listener. For example:

```json
{
  "invoker": "DIV#root.onclick",
  "fn": "QS",
  "source": "http://localhost:4173/frameworks/dist/react.prod.js",
  "blockingMs": 104.8,
  "during": ["click on button#checkout"]
}
```

That relies only on timing, so it works the same for React, Zone.js, zoneless Angular, and frameworks not tested here. Reports (M2 and M5) lead with the element ("click on `button#checkout`: 180ms to paint") and show the script as supporting detail.

## Possible follow-up: naming the handler in full mode

Naming the app's own function needs a JavaScript profile, not LoAF. Full mode already records a Chrome trace; adding V8's sampling profiler category (`disabled-by-default-v8.cpu_profiler`) to it would give self-time per function, including `onCheckout`, during the interaction's frames. That's a bigger piece of work, and traces with profiles are larger again. It's proposed as an M3 option, not built.
