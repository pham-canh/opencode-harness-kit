# Release history

`CHANGELOG.md` is the canonical record of what changed. npm is the artifact
store. Git tags and GitHub releases are the public index. This page explains
the places where those four do not line up, so nobody has to rediscover them.

The rule for new releases is simple: a version that is published to npm gets a
`vX.Y.Z` tag, a GitHub release with the CHANGELOG entry, and two assets - the
npm tarball and its SHA-256. Tags are immutable; history is not rewritten to
make an old release look tidier than it was.

## Backfilled on 2026-11-04

These versions were on npm but had no git tag or GitHub release. The tag points
at the commit that carried the version in `package.json`, and the release uses
the tarball from the registry.

| Version | Commit | Note |
| --- | --- | --- |
| 0.1.0 | `7290e55` | First published version. |
| 0.2.0 | `fb70fd7` | Published before the tag-and-release routine existed. |
| 0.3.3 | `0e34d49` | Staged by a diagnostic with side effects; see the 0.3.4 notes. |

## Published but historically awkward

- **`v0.2.1`** points at a commit that predates `CHANGELOG.md`. Its GitHub
  release notes are taken from the current CHANGELOG, not from a file in the
  tag.
- **`v0.4.3`** is a side tag (`1a913ec`) outside the `main` history. Its
  release notes are taken from the current CHANGELOG. The tag is kept because
  deleting a published tag is worse than documenting it.

## Cut but never published

These versions have commits and CHANGELOG entries, but no npm artifact, tag or
GitHub release. Creating a release for them would imply an artifact that does
not exist.

- **0.3.2** - the publish path was not ready; the changes shipped in 0.3.4.
- **0.5.2** - the tag was cut and the publish was refused; the changes shipped
  in 0.5.3.
- **0.3.0** and **0.3.1** - GitHub drafts with no tag and no npm version; the
  drafts were deleted during the 0.8.0 cleanup.

## Not a release

- **0.0.0-stage** - the registry bootstrap stub. It is deliberately empty and
  has no tag or release.
