/** True when running inside GitHub Actions. */
export function inGitHubActions(env: Record<string, string | undefined> = process.env): boolean {
  return env.GITHUB_ACTIONS === 'true';
}

/** Escapes a value for a GitHub Actions workflow command. */
function escapeData(s: string): string {
  return s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}
function escapeProperty(s: string): string {
  return escapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

/**
 * Formats a `::warning` workflow command, which GitHub shows on the pull request next to
 * the file and line. See https://docs.github.com/actions/reference/workflow-commands-for-github-actions
 */
export function githubWarning(
  message: string,
  where: { file?: string; line?: number; title?: string } = {},
): string {
  const props = [
    where.file ? `file=${escapeProperty(where.file)}` : '',
    where.line ? `line=${where.line}` : '',
    `title=${escapeProperty(where.title ?? 'Smoothness')}`,
  ].filter(Boolean);
  return `::warning ${props.join(',')}::${escapeData(message)}`;
}
