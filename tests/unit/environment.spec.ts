import { test, expect } from '@playwright/test';
import { detectHeadlessMode } from '../../src/environment.js';
import { githubWarning } from '../../src/ci.js';

// Values recorded by the headless-matrix workflow (docs/measurements.md).
test('headless mode from CDP Browser.getVersion', () => {
  const ua = (token: string) =>
    `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ${token} Safari/537.36`;
  expect(
    detectHeadlessMode({
      product: 'HeadlessChrome/131.0.6778.33',
      userAgent: ua('HeadlessChrome/131.0.6778.33'),
    }),
  ).toBe('headless-shell');
  expect(
    detectHeadlessMode({ product: 'Chrome/153.0.8010.12', userAgent: ua('HeadlessChrome/153.0.0.0') }),
  ).toBe('new-headless');
  expect(detectHeadlessMode({ product: 'Chrome/153.0.8010.12', userAgent: ua('Chrome/153.0.0.0') })).toBe(
    'headed',
  );
  expect(detectHeadlessMode({ product: 'Edg/150.0' })).toBe('unknown');
  expect(detectHeadlessMode({})).toBe('unknown');
});

test('githubWarning escapes properties and data', () => {
  expect(githubWarning('p95 up 40%\nclick on button#buy', { file: 'tests/a,b.spec.ts', line: 12 })).toBe(
    '::warning file=tests/a%2Cb.spec.ts,line=12,title=Smoothness::p95 up 40%25%0Aclick on button#buy',
  );
  expect(githubWarning('x')).toBe('::warning title=Smoothness::x');
});
