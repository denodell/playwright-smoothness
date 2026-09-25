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

/**
 * True on a push build of the main (or master) branch, per CI provider. Automatic mode records
 * history only there, so pull requests are compared against main and never change its history.
 */
export function onMainBranch(env: Record<string, string | undefined> = process.env): boolean {
  const main = (b: string | undefined) => b === 'main' || b === 'master';
  if (env.GITHUB_ACTIONS === 'true')
    return env.GITHUB_EVENT_NAME !== 'pull_request' && main(env.GITHUB_REF_NAME);
  if (env.GITLAB_CI) return !env.CI_MERGE_REQUEST_IID && env.CI_COMMIT_BRANCH === env.CI_DEFAULT_BRANCH;
  if (env.TF_BUILD) return env.BUILD_REASON !== 'PullRequest' && main(env.BUILD_SOURCEBRANCHNAME);
  if (env.CIRCLECI) return !env.CIRCLE_PULL_REQUEST && main(env.CIRCLE_BRANCH);
  return false;
}
