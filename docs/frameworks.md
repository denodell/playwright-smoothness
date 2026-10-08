# Attribution with frameworks

When a framework sits between the browser and your event handler, the Long Animation Frames API (LoAF) names the framework's code instead of yours. This page records what `tests/integration/frameworks.spec.ts` measured with React and Angular, whether source maps help, and how full mode's CPU profile names the handler.

## Test apps

There are three apps. Each has a button whose click handler (`onCheckout`) blocks for 150ms, and a search input whose keydown handler (`onSearchKey`) blocks for 60ms. `scripts/build-test-pages.mjs` builds each app twice with esbuild, both times with source maps: `prod` is minified, the way teams ship, and `dev` keeps readable names.

| App                     | How events reach the handler                                                                                   |
| ----------------------- | -------------------------------------------------------------------------------------------------------------- |
| React 19                | One listener per event type on the root container. React's dispatcher finds and calls the component's handler. |
| Angular 21 with Zone.js | Listeners on the elements themselves, each wrapped by Zone.js. This is how most existing Angular apps run.     |
| Angular 21 zoneless     | Listeners on the elements, called through Angular's own wrapper. The default for new Angular apps.             |

Angular is bootstrapped in JIT mode, without the Angular CLI. JIT and AOT builds register listeners the same way (through Angular's `listener` instruction and, with Zone.js, its patched `addEventListener`), so JIT shouldn't hide anything an AOT build would show. If a team finds otherwise, an AOT build is the next thing to test.

## LoAF attribution

These results are from Chrome 153, and were identical locally and on GitHub Actions (PR #2, run 35945190946):

| Page                    | LoAF `invoker`            | LoAF `sourceFunctionName`        | Event Timing target |
| ----------------------- | ------------------------- | -------------------------------- | ------------------- |
| React, dev              | `DIV#root.onclick`        | `dispatchDiscreteEvent`          | `button#checkout`   |
| React, prod             | `DIV#root.onclick`        | `QS` (minified)                  | `button#checkout`   |
| Angular + Zone.js, dev  | `BUTTON#checkout.onclick` | `globalZoneAwareCallback`        | `button#checkout`   |
| Angular + Zone.js, prod | `BUTTON#checkout.onclick` | `m` (minified)                   | `button#checkout`   |
| Angular zoneless, dev   | `BUTTON#checkout.onclick` | _(empty: an anonymous function)_ | `button#checkout`   |
| Angular zoneless, prod  | `BUTTON#checkout.onclick` | _(empty)_                        | `button#checkout`   |

Keydown follows the same pattern, with `DIV#root.onkeydown` for React and `INPUT#search.onkeydown` for Angular.

LoAF measured the work correctly every time, with one long frame of at least 150ms for the click and one for each key press, but it never named `onCheckout` or `onSearchKey`:

- With React, it names React's root listener and dispatcher. The invoker is the root container, not the button.
- With Zone.js, it names the Zone.js wrapper. The invoker is the right element, because Zone.js patches `addEventListener` on the element itself.
- With zoneless Angular, it names an anonymous wrapper, so there's no function name at all.

Event Timing names the real element every time, including behind React's delegation.

## Source maps and LoAF

LoAF's `scripts[]` only records the entry point of each script execution, which is the function the browser called. The browser calls the framework's dispatcher, and the dispatcher calls your handler, so `sourceURL` and `sourceCharPosition` point at the dispatcher. The library looks each script up in the page's source maps, in every mode, so `QS` becomes `dispatchDiscreteEvent` in `react-dom-client.production.js`, with the minified name kept in the script's `generated` field. A source map can't name `onCheckout`, though, because that function is never an entry point. The CPU profile in full mode can, because its stacks include the handler. In an app without a framework dispatcher, the entry point is your own handler, and the source map names it in quick and automatic mode too.

## Linking scripts to interactions

Each entry in `longFrames.topScripts` has a `during` list of the interactions whose frames that script blocked, taken from Event Timing and the scroll listener:

```json
{
  "invoker": "DIV#root.onclick",
  "fn": "QS",
  "source": "http://localhost:4173/frameworks/dist/react.prod.js",
  "blockingMs": 104.8,
  "during": ["click on button#checkout"]
}
```

This only relies on timing, so it works the same for React, Zone.js, zoneless Angular and frameworks that weren't tested here. Failure messages and the reporter summary lead with the element ("click on `button#checkout`: 180ms to paint"), and show the script as supporting detail.

## Naming the handler with the CPU profile

In full mode, the trace also records V8's sampling profiler (`disabled-by-default-v8.cpu_profiler`), which takes a sample about every 140µs. The library takes the samples that fall inside the interaction's long frames and Event Timing windows, adds them up by function, and reports the top functions as `profile.hotFunctions`, each with its self time, total time and most common callers. A profile records whole call stacks, so it sees past the dispatcher to the functions it called.

Minified names are mapped back through the page's source maps. V8 gives each function's position in the bundle (the `(` that opens its parameter list), the identifier just before that position is the minified name, and the source map gives the original name and position. The bundle position is kept as `generated`.

| Page                    | Profile alone                                                                       | With source maps                                                       |
| ----------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| React, dev              | `busyWait` ← **`onCheckout`** ← `executeDispatch` ← …                               | same, located at `work.js:2`                                           |
| React, prod             | `G0` ← `n` ← `Cm` ← …                                                               | `busyWait` ← **`onCheckout`** ← `processDispatchQueue` ← …             |
| Angular + Zone.js, dev  | `busyWait` ← **`onCheckout`** ← `AppComponent_Template_button_click_1_listener` ← … | same                                                                   |
| Angular + Zone.js, prod | `QN` ← **`onCheckout`** ← `yv_Template_button_click_1_listener` ← …                 | `busyWait` ← **`onCheckout`** ← … ← `executeListenerWithErrorHandling` |
| Angular zoneless, prod  | `V1` ← **`onCheckout`** ← `Eg_Template_button_click_1_listener` ← …                 | `busyWait` ← **`onCheckout`** ← …                                      |

`busyWait` is the test pages' stand-in for slow work, and `onCheckout` is the handler that calls it. The handler is named on every build, minified or not, behind React's dispatcher, Zone.js and Angular's listener wrapper.

### Source map loading

Source maps are fetched the way the page would fetch them, through Playwright's request context, so cookies and HTTP credentials apply. `//# sourceMappingURL` comments, `data:` URLs and the `SourceMap` header all work. A page that doesn't publish maps keeps the names V8 reports, without a note, because those are the names the code really has. A map that's referenced but can't be loaded or parsed gets a note.

The decoder is written in-house (`packages/butter-core/src/sourcemap/`) with no dependencies. Index maps (maps with `sections`) aren't supported, and are reported as unsupported.

### Profile limits

- Workers are left out. Each thread has its own profile, and the library only reads the profile for the thread its start mark came from, which is the page's main thread. `test-pages/worker.html` keeps a worker busy next to a slow click handler, and the worker's function never appears.
- V8's optimizing compiler inlines small hot functions into their callers, and the sampled profile then counts their time under the caller. In `examples/react-list`, `expensiveFormat()` is inlined into the `Row` component in some runs and not in others, so the profile names one or the other (both at their `main.jsx` lines, through the source map). DevTools shows the same thing.
- `(program)` is browser work outside JavaScript (style, layout and painting), and `now` is `performance.now()` itself.
