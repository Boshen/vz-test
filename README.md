# vz-test

Public cross-repository integration fixtures for [Boshen/vz](https://github.com/Boshen/vz).
This repository consumes the **built plugin distribution**, so VZ does not need an
npm release for integration testing.

## Automatic checks

Every push, pull request, manual dispatch, and daily scheduled run checks out the
selected VZ source ref into `.vz-source`, installs both frozen lockfiles, runs
VZ's platform/security suite, packages the plugin, runs the fixture contracts, and
builds the production platform. `site` and `library` are separate app projects.

The contract suite uses real Vite/Rolldown builds and an isolated upload transport:

- Full module, chunk, asset, package, plugin-timing, source, and raw-log capture
- Artifact byte counts and SHA-256 integrity
- No collection or requests from local builds and disabled conditions
- Missing OIDC in strict and non-strict modes
- Strict/default upload failure behavior and bounded transient retries
- Distinct monorepo app identities

VZ's own suite additionally verifies signed OIDC claims, GitHub repository access,
private/public transitions, webhook signatures and replay, multipart upload and
concurrent completion, cross-project comparisons, deletion, retention cleanup,
and large manifests that exceed D1's per-row limit.

## Live OIDC tests

Install the VZ platform's GitHub App on `Boshen/vz-test`. Deploy VZ through
`https://api.void.cloud`, then use the **resulting application URL** as the
`VZ_ENDPOINT` Actions repository variable:

```sh
gh variable set VZ_ENDPOINT --repo Boshen/vz-test --body https://<vz-app>.void.app
gh workflow run integration.yml --repo Boshen/vz-test
```

Alternatively pass `endpoint` in a manual workflow dispatch. The live job has
`id-token: write` and uses no persistent upload secret. It uploads two builds per
app and verifies public report reads, every diagnostic dataset, safe source byte
ranges, anonymous deletion rejection, signed repository/commit provenance, and
explicit build comparisons. Report links appear in the job summary.

**Until the endpoint and GitHub App are configured, the live job is visibly
skipped; the contract suite is not presented as a live deployment test.** Fork PRs
never run the live job. Completed live reports stay until a maintainer deletes them,
matching VZ's retention policy. The platform's private access paths are covered by
the isolated security suite; this fixture repository remains public.

## Run locally

Use the Node version in `.node-version` and Vite+.

```sh
git clone https://github.com/Boshen/vz .vz-source
vp install --frozen-lockfile
vp -C .vz-source install --frozen-lockfile
vp -C .vz-source run pack:plugin
vp check --deny-warnings
vp run test
```

Live uploads deliberately refuse to run locally. To test a different VZ revision,
check it out in `.vz-source` and rebuild the plugin. The `.vz-source` checkout and
`.artifacts` outputs are ignored and never committed.
