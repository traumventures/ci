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

| `gate.yml` | the first job of a deploy or release: the commit is on `main` and its `ci` passed; waits for a run in progress |

| `actions/postgres` (composite action) | a throwaway Postgres on `127.0.0.1`, preferred port or the next free one (`url`/`port` outputs); jobs share one network namespace |

```yaml
- uses: traumventures/ci/actions/postgres@v1
  with: { user: process, password: process, database: process_test }
```

| `actions/await-ci` | what `gate.yml` runs, for a step inside an existing job |
| `actions/green` | the "already passed" marker the workflows above use (lookup/save) |
| `actions/rust-cache` | cargo target, registry and incremental caches on a sticky disk, for jobs that run cargo themselves |
| `actions/bun-cache` | Bun's install cache on a sticky disk, for jobs that run `bun install` themselves |
| `actions/source-mtimes` | dates unchanged sources back to the build that compiled them, so mtime-based tools reuse a kept build directory |

**Skipping what already passed.** `typescript`, `rust`, `go` and `docker`
(build checks, not publishing) skip draft pull requests and, when the job
already passed with the same tree and the same inputs, every step after the
checkout (`actions/green`: a marker artifact named after a hash of
`git ls-files -s`, the inputs and this repository's version). The common
case is the merge commit on `main`: the pull request tested that exact tree,
so `main`'s run finishes in seconds. `skip-unchanged: false` turns it off,
`inputs-paths: "services/x shared"` narrows the tree to what decides the result.
The caller grants `actions: read` (listing artifacts); without it nothing is
skipped.

**Caches.** On Blacksmith, state that only speeds things up lives on sticky
disks: Bun's install cache, Rust's target directory and registry (with
incremental builds), Go's module and build caches, Docker layers
(Blacksmith's BuildKit builder). Every passing run commits its disk when it
changed, pull requests included. Committing only on `main` left the disks
empty: `main`'s run is usually skipped (the pull request tested its tree), so
nothing ever filled them and every pull request built cold (Rust: 5-8 minutes
of dependencies). The caches are keyed on content (cargo fingerprints, Go
build IDs, Bun's package store, BuildKit digests), so a snapshot left by
another branch is only less warm, never wrong; concurrent jobs each work on a
clone and the last commit wins. A pull request's code can write into a disk
other runs mount; these are private repositories of one team, the same trust
the `green` markers already rely on. Other runners fall back to the Actions
cache, saved by `main` only.

Cargo judges freshness by file mtime, and a checkout dates every file to the
checkout, so a kept target directory still rebuilt every workspace crate.
`actions/source-mtimes` records the mtimes after a passing build and dates
unchanged files back on the next run: only crates whose inputs changed
rebuild.

Jobs that run cargo or `bun install` themselves get the same disks from
`actions/rust-cache` (a drop-in for `Swatinem/rust-cache`: `target/` becomes a
link to the disk) and `actions/bun-cache` (instead of an `actions/cache` step
on `~/.bun/install/cache`).

**Runner environment.** Blacksmith VMs behave like GitHub's hosted Ubuntu:
Docker, `services:`, `sudo`, published ports on localhost; nothing is shared
between jobs.

Every input has a default; a step can be replaced by a command or skipped
with `""`.

## Bun, not Node

Every JavaScript/TypeScript project runs on Bun 1.4.3: `bun install`,
`bun run`, `bunx`, `bun test`, `bun pm pack`. Type checks use `bun check`
(Bun's native checker: same errors as `tsc`, all cores; `bun check -p
<tsconfig>`), not `tsc --noEmit`. **No package.json script may be called
`check`**: Bun then runs that script for `bun check` (also from a parent
directory) instead of the checker. Name such scripts `verify` or `check:all`.
`bun --check` without arguments always runs the checker on `./tsconfig.json`.
No `setup-node`, `npm` or `npx`. The only
exceptions are jobs whose subject is Node itself (a package's Node
compatibility matrix, a Node runtime target); they say so in a comment.

## The standard layout of a repository

**`.github/workflows/ci.yml`**: every pull request and every push to `main`.

```yaml
name: ci

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  actions: read               # the "already passed" lookup

# Pull requests: a new push cancels the older run. main: every commit keeps
# its own run and result; gates ask for exactly that commit.
concurrency:
  group: ci-${{ github.event.pull_request.number && format('pr-{0}', github.event.pull_request.number) || github.sha }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}

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
  actions: read

jobs:
  gate:                       # only a commit of main whose ci passed is published
    uses: traumventures/ci/.github/workflows/gate.yml@v1
  docker:
    needs: gate
    uses: traumventures/ci/.github/workflows/docker.yml@v1
    with:
      image: my-service
      push: true
    secrets: inherit
```

Jobs a repository writes itself (not through these workflows) add
`if: github.event.pull_request.draft != true`.

**`.github/workflows/deploy-production.yml`**: only repositories with a
production stack (traumwohnung, common-infra): a fast-forward of
`deploy/production` to a commit of `main` deploys it (see
`deployment/cd/README.md` there), after a `gate` job (`gate.yml`) confirmed
that `ci` passed for that commit. These run on their own deploy runners, not
on the shared pool.

Registry credentials: one Scaleway IAM application per repository
(`<repository>-publish`, `ContainerRegistryFullAccess` on the project), its
key as the repository secret `SCW_REGISTRY_PUSH_KEY`.

## Versions

Callers pin `@v1`. A compatible change moves the `v1` tag; a breaking one
starts `v2`.
