import { test, expect } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initAgents, skillSource, updateAgentsMd } from '../../packages/playwright-butter/src/init-agents.js';

const SKILL = '.agents/skills/playwright-butter/SKILL.md';

test('the shipped skill has the frontmatter agents read, and its recipes link resolves', () => {
  const skill = readFileSync(join(skillSource(), 'SKILL.md'), 'utf8');
  expect(skill).toMatch(/^---\nname: playwright-butter\ndescription: .{50,1024}\n---\n/);
  expect(existsSync(join(skillSource(), 'references', 'recipes.md'))).toBe(true);
  expect(skill).toContain('](references/recipes.md)');
});

test('AGENTS.md: created, appended to, and replaced in place on a second run', () => {
  const fresh = updateAgentsMd(null, SKILL);
  expect(fresh).toContain('## Smoothness checks');
  expect(fresh).toContain(SKILL);

  const appended = updateAgentsMd('# Project\n\nUse pnpm.\n', SKILL);
  expect(appended.startsWith('# Project\n\nUse pnpm.\n\n<!-- playwright-butter:start -->')).toBe(true);

  const edited = appended.replace('Use pnpm.', 'Use pnpm.\n\nMore notes.') + '\n## Later\n';
  const again = updateAgentsMd(edited, 'skills/playwright-butter/SKILL.md');
  expect(again.match(/playwright-butter:start/g)).toHaveLength(1);
  expect(again).toContain('skills/playwright-butter/SKILL.md');
  expect(again).not.toContain(SKILL);
  expect(again).toContain('More notes.');
  expect(again.endsWith('\n## Later\n')).toBe(true);
});

test('initAgents copies the skill to each folder and replaces an older copy', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'init-agents-'));
  try {
    writeFileSync(join(cwd, 'AGENTS.md'), '# Agents\n');
    const stale = join(cwd, '.claude/skills/playwright-butter/old.md');
    initAgents({ cwd });
    writeFileSync(stale, 'from an older version');
    const written = initAgents({ cwd });
    expect(written).toEqual([
      '.claude/skills/playwright-butter/',
      '.agents/skills/playwright-butter/',
      'AGENTS.md',
    ]);
    for (const dir of ['.claude/skills', '.agents/skills']) {
      expect(existsSync(join(cwd, dir, 'playwright-butter/SKILL.md'))).toBe(true);
      expect(existsSync(join(cwd, dir, 'playwright-butter/references/recipes.md'))).toBe(true);
    }
    expect(existsSync(stale)).toBe(false);
    const agents = readFileSync(join(cwd, 'AGENTS.md'), 'utf8');
    expect(agents.startsWith('# Agents\n')).toBe(true);
    expect(agents).toContain(SKILL);

    expect(initAgents({ cwd, dirs: ['tools/skills'], agentsMd: false })).toEqual([
      'tools/skills/playwright-butter/',
    ]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('a project set up under the old name moves to the new one', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'init-agents-'));
  try {
    const old = '.agents/skills/playwright-smoothness/SKILL.md';
    mkdirSync(join(cwd, '.agents/skills/playwright-smoothness'), { recursive: true });
    writeFileSync(join(cwd, old), 'the old skill');
    writeFileSync(
      join(cwd, 'AGENTS.md'),
      `# Agents\n\n<!-- playwright-smoothness:start -->\nFollow \`${old}\`.\n<!-- playwright-smoothness:end -->\n\n## Later\n`,
    );
    initAgents({ cwd });
    expect(existsSync(join(cwd, '.agents/skills/playwright-smoothness'))).toBe(false);
    const agents = readFileSync(join(cwd, 'AGENTS.md'), 'utf8');
    expect(agents).not.toContain('playwright-smoothness');
    expect(agents).toContain(SKILL);
    expect(agents.endsWith('\n## Later\n')).toBe(true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
