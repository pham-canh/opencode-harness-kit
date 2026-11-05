# Contributing

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md).
By participating, you agree to uphold it.

Run `npm run check` before pushing. Driver changes need `npm test`; loop
behaviour changes also need `npm run gate:loop`. V2 changes need
`npm run gate:v2` on a 2.x binary.

Do not add runtime dependencies. Keep `.space/` writes atomic and redacted.

## Cutting a release

1. Bump `package.json` and `package-lock.json` to the same version.
2. Move the `[Unreleased]` entries under a new
   `## [X.Y.Z] — YYYY-MM-DD` heading, newest first.
3. Run `npm run selfcheck`. It builds, checks the release gate, typechecks,
   runs the suite, checks the graph and premises, and installs into a fresh
   directory.
4. Commit and push `main`, then tag and push the tag:

   ```bash
   git tag vX.Y.Z
   git push origin main vX.Y.Z
   ```

The tag is the trigger. `.github/workflows/ci.yml` runs the full matrix, then
publishes through npm trusted publishing and creates the GitHub release with
the CHANGELOG entry, the npm tarball and its SHA-256. A re-run of a published
tag is green: it finds the version on the registry and only refreshes the
release assets.

[`docs/RELEASE-HISTORY.md`](docs/RELEASE-HISTORY.md) explains the historical
gaps between the tag, npm and release histories.
