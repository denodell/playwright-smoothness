# Releasing

Releases use [changesets](https://github.com/changesets/changesets).

1. Each user-facing change gets a changeset in its pull request: `npx changeset`, choosing patch, minor or major. The file goes in `.changeset/`.
2. On `main`, `npx changeset version` bumps `package.json` and writes `CHANGELOG.md` from the pending changesets. The changelog can be edited for readability before committing.
3. `npm run release:check` builds and runs `npm publish --dry-run`. The tarball should hold only `dist/`, `README.md`, `LICENSE` and `package.json`.
4. `npm run release` builds and runs `changeset publish`, which publishes to npm and creates a git tag. It needs you to be logged in to npm (`npm login`) with publish rights to the package. `git push --follow-tags` then pushes the tag.
5. A GitHub release is made from the tag, with the changelog section as its body.

The CI workflows pin Playwright (and so Chromium). The nightly `latest.yml` workflow runs the suite against the newest Playwright, so a change in Chrome's trace format or performance APIs shows up before users hit it.
