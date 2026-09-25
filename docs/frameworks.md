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

Chrome 153, measured locally (GitHub Actions results are added in the M1 pull request):

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

## Naming the handler: the CPU profile (full mode)

Full mode records V8's sampling profiler in the same trace (`disabled-by-default-v8.cpu_profiler`, a sample about every 140µs). The library attributes the samples that fall inside the interaction's long frames and Event Timing windows to functions, and reports the top ones as `profile.hotFunctions`, each with self time, total time and its most common callers. A profile has whole stacks, not just entry points, so it can see past the dispatcher.

Minified names are mapped back through the page's source maps: V8 gives each function's position in the bundle (the `(` of its parameter list), the identifier just before it is the minified name, and the source map gives its original name and position. The bundle position is kept as `generated`.

| Page                    | Profile alone                                                                       | With source maps                                                       |
| ----------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| React, dev              | `busyWait` ← **`onCheckout`** ← `executeDispatch` ← …                               | same, located at `work.js:2`                                           |
| React, prod             | `G0` ← `n` ← `Cm` ← …                                                               | `busyWait` ← **`onCheckout`** ← `processDispatchQueue` ← …             |
| Angular + Zone.js, dev  | `busyWait` ← **`onCheckout`** ← `AppComponent_Template_button_click_1_listener` ← … | same                                                                   |
| Angular + Zone.js, prod | `QN` ← **`onCheckout`** ← `yv_Template_button_click_1_listener` ← …                 | `busyWait` ← **`onCheckout`** ← … ← `executeListenerWithErrorHandling` |
| Angular zoneless, prod  | `V1` ← **`onCheckout`** ← `Eg_Template_button_click_1_listener` ← …                 | `busyWait` ← **`onCheckout`** ← …                                      |

(`busyWait` is the test pages' stand-in for slow work, and `onCheckout` is the handler that calls it.)

- **The handler is named on every build**, minified or not, behind React's dispatcher, Zone.js, and Angular's listener wrapper.
- **Source maps are fetched the way the page would fetch them**, through Playwright's request context, so cookies and HTTP credentials apply. `//# sourceMappingURL` comments, `data:` URLs and the `SourceMap` header all work. Pages that don't publish maps keep the names V8 reports, without a note, because those names are what the code is actually called. A map that is referenced but can't be loaded or parsed gets a note.
- The decoder is in-house (`src/sourcemap/`, no dependencies). Index maps (with `sections`) aren't supported and are reported as such.
- **Workers are excluded.** Each thread has its own profile, and the library reads only the one on the thread its start mark came from (the page's main thread). `test-pages/worker.html` keeps a worker busy next to a slow click handler; the worker's function never appears.
- `(program)` is browser work outside JavaScript (style, layout, painting), and `now` is `performance.now()` itself.
