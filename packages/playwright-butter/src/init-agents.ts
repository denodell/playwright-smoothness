import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { forwardSlashes } from 'butter-core';
import { PACKAGE_NAME } from './constants.js';

export const SKILL_DIRS = ['.claude/skills', '.agents/skills'];
const START = `<!-- ${PACKAGE_NAME}:start -->`;
const END = `<!-- ${PACKAGE_NAME}:end -->`;
const OLD_NAME = 'playwright-smoothness';
const OLD_START = `<!-- ${OLD_NAME}:start -->`;
const OLD_END = `<!-- ${OLD_NAME}:end -->`;

export function skillSource(): string {
  return fileURLToPath(new URL('../skills/playwright-butter', import.meta.url));
}

export interface InitAgentsOptions {
  cwd: string;
  dirs?: string[];
  agentsMd?: boolean;
  source?: string;
}

function agentsBlock(skillPath: string): string {
  return [
    START,
    '## Smoothness checks',
    '',
    `This project checks that interactions and scrolling stay smooth with ${PACKAGE_NAME}. To fix a check that got worse, such as a fix brief, a \`.fix.md\` file or a \`toBeSmooth()\` failure, follow \`${skillPath}\`.`,
    END,
  ].join('\n');
}

export function updateAgentsMd(existing: string | null, skillPath: string): string {
  const block = agentsBlock(skillPath);
  if (!existing) return block + '\n';
  for (const [open, close] of [
    [START, END],
    [OLD_START, OLD_END],
  ] as const) {
    const start = existing.indexOf(open);
    const end = existing.indexOf(close);
    if (start >= 0 && end > start)
      return existing.slice(0, start) + block + existing.slice(end + close.length);
  }
  return existing.replace(/\s*$/, '') + '\n\n' + block + '\n';
}

export function initAgents(options: InitAgentsOptions): string[] {
  const { cwd, dirs = SKILL_DIRS, agentsMd = true, source = skillSource() } = options;
  const written: string[] = [];
  for (const dir of dirs) {
    const target = join(cwd, dir, PACKAGE_NAME);
    rmSync(target, { recursive: true, force: true });
    rmSync(join(cwd, dir, OLD_NAME), { recursive: true, force: true });
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target, { recursive: true });
    written.push(forwardSlashes(relative(cwd, target)) + '/');
  }
  if (agentsMd && dirs.length) {
    const file = join(cwd, 'AGENTS.md');
    const skillPath = forwardSlashes(join(dirs[dirs.length - 1]!, PACKAGE_NAME, 'SKILL.md'));
    writeFileSync(file, updateAgentsMd(existsSync(file) ? readFileSync(file, 'utf8') : null, skillPath));
    written.push('AGENTS.md');
  }
  return written;
}
