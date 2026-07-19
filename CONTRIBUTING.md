# Contributing to permission-core

This file is the maintainer entry point. The documentation site is written for package consumers; repository setup, gates, packaging, and release operations live here.

## Setup

Use Node.js `>=20.19.0` for the full repository gate because the optional Vext 0.3.26 integration requires it. The package root and `match` entries continue to support Node.js `>=18.0.0`. Install both dependency trees from their locks:

```bash
npm ci
npm --prefix website ci
```

## Runtime gates

Run the focused checks while editing, then the full gate before requesting review:

```bash
npm run typecheck
npm run test:complexity
npm test
npm run test:coverage
npm run build
```

Coverage floors are enforced by `scripts/check-coverage.mjs`, and touched hotspot budgets are enforced by `scripts/check-complexity.mjs`. Do not lower either set of limits to make a change pass; update a budget only with review evidence that the responsibility boundary remains maintainable.

## Documentation gates

Source documentation and the rendered site have separate contracts:

```bash
npm run test:docs
npm run docs:first-success
npm --prefix website run build
npm run test:docs:rendered -- --root=website/dist --channel=preview --contract=full --base=/permission-core/
```

`npm run test:docs` validates the 34 EN/ZH page pairs, the exact manifest/source owners, role contracts, responses, duplicate responsibility, links, retired surfaces, and source-backed claims. The rendered check validates all 68 routes, locale counterparts, navigation links, metadata, accessible names, and generated structure. `docs:first-success` packs the current package and runs its first authorization decision from an isolated consumer.

## Examples

Run every repository-owned scenario:

```bash
npm run example:all
```

When changing one integration, run its focused script first and `example:all` before review. Runnable source belongs under `examples/`; site pages should reference or explain that source instead of maintaining a divergent copy.

## Package consumer

Verify exports, files, CommonJS/ESM loading, types, and installation from the packed tarball:

```bash
npm run test:package
```

Do not use a source-tree-only import as release evidence.

## Continuous integration

Pull requests targeting `main` and pushes to `main` run the CI workflow on Node.js `20.19`. It installs both lockfiles, runs `npm run prepublishOnly`, builds the preview documentation, and validates every generated preview route. The Pages workflow owns deployment, while the tag-only Publish workflow owns npm publication; neither one replaces the pull-request code gate.

## Site channels

The published site has two channels:

- npm latest tag builds the stable site root.
- current `main` builds the `/next/` preview.

The Pages workflow assembles both into one artifact. Preview content must remain `noindex`, and the stable build must never fall back to current `main` when its release tag is missing.

## Release boundary

Contributors may prepare code, documentation, changelog entries, and verification evidence. Only an authorized maintainer may create a Git tag, push release refs, or run `npm publish`. A green site build does not authorize an npm release.

Before a maintainer releases, verify the version/changelog, full tests and coverage, package consumer smoke, stable/preview site assembly, and rollback path. Follow the repository's current release review rather than inferring permission from this file.

## Release recovery

Treat an npm version and its Git tag as immutable. Before pushing a release tag, confirm that the version is absent from both the registry and the remote tag namespace, and keep the reviewed commit unchanged between verification and tagging.

```bash
npm view permission-core@<version> version
git ls-remote --tags origin refs/tags/v<version>
```

1. If the tag exists but npm publish failed for an infrastructure or credential reason, do not force-move the tag. Re-run the failed workflow only when the tagged commit is unchanged.
2. If source changes are required after a failed tagged attempt, increment the package version and create a new tag. Do not reuse the failed version/tag pair.
3. If npm already contains a defective version, do not overwrite it. Deprecate that exact version, publish a corrected patch, and change `latest` only with explicit maintainer approval.

```bash
npm deprecate permission-core@<bad-version> "Use <fixed-version> instead"
npm dist-tag add permission-core@<fixed-version> latest
```

4. If npm succeeds but Pages fails, leave the package and tag untouched. Fix the Pages workflow on `main` and re-run it; if the stable release documentation itself is wrong, publish a corrected patch rather than rewriting the release tag.

After release, verify the registry version and provenance, install the exact registry version in a clean consumer, exercise root/match and optional Vext ESM/CJS/types entries, confirm the tag resolves to the reviewed commit, and check both the stable site root and `/next/` preview. A failed check opens a release incident; it does not authorize an unpublish, force-push, or tag rewrite.
