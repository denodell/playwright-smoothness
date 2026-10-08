# Releasing

Two packages are released together at the same version: `butter-core` and `playwright-butter`. Versions come from [changesets](https://github.com/changesets/changesets), which keeps the two in step (the `fixed` group in `.changeset/config.json`). Publishing is done by the release workflow, `.github/workflows/release.yml`, when a version tag is pushed.

1. Each user-facing change gets a changeset in its pull request. `npx changeset` asks for patch, minor or major and writes a file to `.changeset/`.
2. When it's time to release, `npx changeset version` bumps both `package.json` files and adds the pending changesets to each package's `CHANGELOG.md`. The changelogs can be edited for readability before the version bump is merged to `main`.
3. `npm run release:check` builds both packages and runs `npm publish --dry-run` for each. Each tarball should contain `dist/`, `README.md`, `LICENSE` and `package.json`, and `playwright-butter` also `skills/`. The licence, and `playwright-butter`'s README, are copied in when the package is packed, with the README's links pointing at GitHub so they work on npmjs.com.
4. Tagging the merged commit on `main` with the version, such as `git tag v1.1.0 && git push origin v1.1.0`, starts the release workflow. It checks the tag matches both packages and is on `main`, and runs lint, the type check and the unit tests. It then stages each package that isn't on npm at that version yet, creates the GitHub release from `playwright-butter`'s changelog section, and moves the major tag (`v1`) to the release, which is the tag the GitHub Action is used by.
5. A staged version isn't public until a maintainer approves it, under the Staged Packages tab on npmjs.com or with `npm stage approve <stage-id>`, with two-factor authentication. `butter-core` is approved first, since `playwright-butter` depends on it.

## npm access

The workflow stages releases through npm's trusted publishing, so no npm token is stored in GitHub. Each package has a trusted publisher on npmjs.com, under its Settings tab: GitHub Actions, the user `denodell`, the repository `playwright-butter` and the workflow `release.yml`, with direct publishing left off, so the workflow can only stage. A package's first version was published by hand with `npm publish`, because a trusted publisher can only be added to a package that already exists.

The CI workflows pin Playwright, and so Chromium. The nightly `latest.yml` workflow runs the suite against the newest Playwright, so a change in Chrome's trace format or performance APIs shows up before users hit it.
