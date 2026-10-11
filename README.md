# ci

Reusable GitHub Actions workflows: the one way every traumventures repository
tests, builds and publishes. All of them run on our own runners
([gh-runners](https://github.com/traumventures/gh-runners),
`runs-on: [self-hosted, traumventures]`).

| Workflow | Does |
|---|---|
| `typescript.yml` | Bun: `install --frozen-lockfile`, then `typecheck`, `lint`, `test`, `build` when the package defines them |
| `rust.yml` | `cargo fmt --check`, Clippy `-D warnings`, `cargo test`, all `--locked`; toolchain from `rust-toolchain.toml` |
| `go.yml` | gofmt, `go vet`, `go test -race` |
| `docker.yml` | builds an image; with `push: true` publishes `rg.fr-par.scw.cloud/traumventures/<repository>/<image>` as `:<sha>`, on a tag `v1.2.3` also `:1.2.3` |

| `actions/postgres` (composite action) | a throwaway Postgres on the job's `127.0.0.1` (instead of `services:`, which on our containerized runners would not be reachable on localhost) |

```yaml
- uses: traumventures/ci/actions/postgres@v1
  with: { user: process, password: process, database: process_test }
```

Every input has a default; a step can be replaced by a command or skipped
with `""`.

## The standard layout of a repository

**`.github/workflows/ci.yml`**: every pull request and every push to `main`.

```yaml
name: ci

on:
  pull_request:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  typescript:                 # or rust / go, one job per language or package
    uses: traumventures/ci/.github/workflows/typescript.yml@v1
  docker:                     # repositories with a Dockerfile: build check, no push
    uses: traumventures/ci/.github/workflows/docker.yml@v1
    with:
      image: my-service
```

**`.github/workflows/release.yml`**: publishes. A tag `v<version>` for
versioned artifacts; repositories whose consumers pin commits (dreamflared)
also publish every push to `main`.

```yaml
name: release

on:
  push:
    tags: ["v*"]

permissions:
  contents: read

jobs:
  docker:
    uses: traumventures/ci/.github/workflows/docker.yml@v1
    with:
      image: my-service
      push: true
    secrets: inherit
```

**`.github/workflows/deploy-production.yml`**: only repositories with a
production stack (traumwohnung, common-infra): a fast-forward of
`deploy/production` to a commit of `main` deploys it (see
`deployment/cd/README.md` there). These run on their own deploy runners, not
on the shared pool.

Registry credentials: one Scaleway IAM application per repository
(`<repository>-publish`, `ContainerRegistryFullAccess` on the project), its
key as the repository secret `SCW_REGISTRY_PUSH_KEY`.

## Versions

Callers pin `@v1`. A compatible change moves the `v1` tag; a breaking one
starts `v2`.
