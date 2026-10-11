# ci

Reusable GitHub Actions workflows: the one way every traumventures repository
tests, builds and publishes. They run on **Blacksmith** (`blacksmith-4vcpu-ubuntu-2404`
by default, a fresh VM per job; pass `runner: '["blacksmith-8vcpu-ubuntu-2404"]'`
for heavy suites, 2/4/8/16/32 vCPU exist).

Only jobs that hold production credentials or need the dev box stay on our own
runners ([gh-runners](https://github.com/traumventures/gh-runners)): the
`deploy-production` workflows (their own deploy runners, devbox BuildKit
cache) and traumwohnung's preview workflows (`runs-on: [self-hosted, traumventures]`).

| Workflow | Does |
|---|---|
| `typescript.yml` | Bun 1.4.3: `install --frozen-lockfile`, then `typecheck` (script, else `bun check`), `lint`, `test`, `build` when the package defines them |
| `rust.yml` | `cargo fmt --check`, Clippy `-D warnings`, `cargo test`, all `--locked`; toolchain from `rust-toolchain.toml` |
| `go.yml` | gofmt, `go vet`, `go test -race` |
| `docker.yml` | builds an image; with `push: true` publishes `rg.fr-par.scw.cloud/traumventures/<repository>/<image>` as `:<sha>`, on a tag `v1.2.3` also `:1.2.3` |

| `actions/postgres` (composite action) | a throwaway Postgres on `127.0.0.1`, preferred port or the next free one (`url`/`port` outputs); jobs share one network namespace |

```yaml
- uses: traumventures/ci/actions/postgres@v1
  with: { user: process, password: process, database: process_test }
```

**Runner environment.** Blacksmith VMs behave like GitHub's hosted Ubuntu:
Docker, `services:`, `sudo`, published ports on localhost; nothing is shared
between jobs.

Every input has a default; a step can be replaced by a command or skipped
with `""`.

## Bun, not Node

Every JavaScript/TypeScript project runs on Bun 1.4.3: `bun install`,
`bun run`, `bunx`, `bun test`, `bun pm pack`. Type checks use `bun check`
(Bun's native checker: same errors as `tsc`, all cores; `bun check -p
<tsconfig>`), not `tsc --noEmit`. No `setup-node`, `npm` or `npx`. The only
exceptions are jobs whose subject is Node itself (a package's Node
compatibility matrix, a Node runtime target); they say so in a comment.

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
