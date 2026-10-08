// Copies the licence and the package's README into a package folder before `npm pack` or
// `npm publish`. playwright-butter gets the repository's README; butter-core has its own.
// Run by each package's prepack script: node ../../scripts/copy-package-docs.mjs <package>
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_URL = 'https://github.com/denodell/playwright-butter';
const RAW_URL = 'https://raw.githubusercontent.com/denodell/playwright-butter/main';

export function absoluteLinks(markdown) {
  return markdown.replace(/(!?)\[([^\]]*)\]\(([^)\s]+)\)/g, (match, image, text, target) => {
    if (/^([a-z]+:|#|\/)/i.test(target)) return match;
    const url = image ? `${RAW_URL}/${target}` : `${REPO_URL}/blob/main/${target}`;
    return `${image}[${text}](${url})`;
  });
}

const repo = join(import.meta.dirname, '..');
const pkg = process.argv[2];
if (pkg) {
  const dir = join(repo, 'packages', pkg);
  copyFileSync(join(repo, 'LICENSE'), join(dir, 'LICENSE'));
  if (pkg === 'playwright-butter') {
    writeFileSync(join(dir, 'README.md'), absoluteLinks(readFileSync(join(repo, 'README.md'), 'utf8')));
  }
}
