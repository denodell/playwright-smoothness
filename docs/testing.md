# Testing

- `npm run test:unit` runs the unit tests, which need no browser.
- `npm run test:integration` runs the integration tests in Chromium and Firefox, and the end-to-end tests, which run Playwright against the built packages.
- `npm test` runs those and the blank-row detection tests.
- `npm run coverage` builds the packages, runs the unit, integration and end-to-end tests with coverage, and writes a report to `coverage/` (open `coverage/index.html`). It takes a while, since coverage slows the tests down; a few timing tests can fail under it for that reason alone. Pass other projects after `--` to measure them instead, such as `npm run coverage -- --project=unit`.

Code that runs in the page, such as the collector and the replay encoder, is covered too: the run records the browser's own coverage of each page and maps it back to the source files. So is the code the end-to-end tests run from the built packages, which is mapped back to the source files through each bundle's source map.
