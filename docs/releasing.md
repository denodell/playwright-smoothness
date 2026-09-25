# Releasing

Releases use [changesets](https://github.com/changesets/changesets).

1. **Describe each user-facing change** in its pull request: `npx changeset`, choosing patch, minor or major. The file goes in `.changeset/`.
2. **Version.** On `main`: `npx changeset version`. This bumps `package.json` and writes `CHANGELOG.md` from the pending changesets. Edit the changelog for readability if needed, and commit.
3. **Check the package**: `npm run release:check` builds and runs `npm publish --dry-run`. The tarball should hold only `dist/`, `README.md`, `LICENSE` and `package.json`.
4. **Publish**: `npm run release` builds and runs `changeset publish`, which publishes to npm and creates a git tag. It needs you to be logged in to npm (`npm login`) with publish rights to the package. Push the tag with `git push --follow-tags`.
5. **Release notes**: create a GitHub release from the tag, with the changelog section as its body.

The CI workflows pin Playwright (and so Chromium). The nightly `latest.yml` workflow runs the suite against the newest Playwright, so a change in Chrome's trace format or performance APIs shows up before users hit it.
