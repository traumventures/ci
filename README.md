# ci

Reusable GitHub Actions workflows: the one way every traumventures repository
tests, builds and publishes.

**Runners.** Private repositories run on our own runners on the dev box
(`["self-hosted","traumventures","devbox"]`: one ephemeral org runner
`devbox-1`, one fresh container per job, under the unprivileged `gh-ci`
user's rootless Docker). Public repositories run on GitHub-hosted
`ubuntu-latest` (free for public repositories): our runner group does not
serve public repositories, because anyone could open a pull request there that
adds a workflow and runs its code on the dev box. The workflows pick the
runner from the repository's visibility; `runner:` (runs-on as JSON)
overrides it. GitHub-hosted runners are blocked by billing for private
repositories. Jobs a repository writes itself use
`runs-on: [self-hosted, traumventures, devbox]` (private) or `ubuntu-latest`
(public).

The `deploy-production` workflows keep their own deploy runners (production
credentials, devbox BuildKit cache).

| Workflow | Does |
|---|---|
| `typescript.yml` | Bun 1.4.4: `install --frozen-lockfile`, then `typecheck` (script, else `bun check`), `lint`, `test`, `build` when the package defines them |
| `rust.yml` | `cargo fmt --check`, Clippy `-D warnings`, `cargo test`, all `--locked`; toolchain from `rust-toolchain.toml` |
| `go.yml` | gofmt, `go vet`, `go test -race` |
| `docker.yml` | builds an image; with `push: true` publishes `rg.fr-par.scw.cloud/traumventures/<repository>/<image>` as `:<sha>`, on a tag `v1.2.3` also `:1.2.3` |

| `gate.yml` | the first job of a deploy or release: the commit is on `main` (and with the default `await-ci: true` its `ci` passed; waits for a run in progress). CI runs only on demand and inside deploys and releases, so those pass `await-ci: false` and call their own `ci.yml` |

| `actions/postgres` (composite action) | a throwaway Postgres on the job's `127.0.0.1`, preferred port or the next free one (`url`/`port` outputs) |

```yaml
- uses: traumventures/ci/actions/postgres@v1
  with: { user: process, password: process, database: process_test }
```

| `actions/await-ci` | what `gate.yml` runs, for a step inside an existing job |
| `actions/green` | the "already passed" marker the workflows above use (lookup/save) |
| `actions/rust-cache` | a persistent cargo target directory (incremental, restored mtimes) and sccache, for jobs that run cargo themselves |
| `actions/bun-cache` | Bun's persistent install cache, for jobs that run `bun install` themselves |
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

**Caches.** Our runners keep what only speeds things up on the dev box's own
disk, in the runners' persistent cache directory (`~/.cache/traumventures-ci`
in the runner container, the `gh-runner-cache` volume of `gh-ci`'s Docker):
nothing is uploaded to or downloaded from the Actions cache, which matters on
the dev box's slow upstream.

- **Rust** (`actions/rust-cache`): each repository and key has two *lanes*,
  persistent target directories; a job takes a free lane and holds it under a
  lock until it ends (a third concurrent job waits, after 20 minutes it
  builds cold), so jobs never share a target directory. Cargo builds in the
  lane through `CARGO_TARGET_DIR` (one path on every runner; build script
  outputs name it), `<workspace>/target` is a link to it, builds are
  incremental, and `actions/source-mtimes` dates unchanged sources back to
  the passing build that produced the lane: only crates whose inputs
  changed rebuild. The checkout path differs per runner
  (`/home/gh-ci/work/devbox-N`) and cargo does not notice a changed
  `CARGO_MANIFEST_DIR` baked in by `env!`, so after a build from another
  runner the workspace crates rebuild (dependencies stay). The
  record is consumed when read and written again only by a passing job, so
  after a failed or cancelled build the next one rebuilds the workspace
  crates (never stale). A lane is dropped above 40 GB (`max-gb`) or when the
  disk is 85 % full; lanes unused for 14 days are dropped by the next job.
  Below the lanes, **sccache** (in the runner image) caches compiled
  dependencies, so a cold lane, a new key or another repository with the same
  dependencies does not compile them again. Local sccache storage allows one
  server per directory, so each runner has its own (20 GB each); the server
  listens on a socket of the job, as all runners share one network
  namespace. Workspace crates, built incrementally (cargo's profile
  default; `CARGO_INCREMENTAL` stays unset, sccache refuses `=1`), are
  compiled, not cached. Cargo's registry and git checkouts live in
  the runners' persistent `~/.cargo`, toolchains in a per-runner
  `~/.rustup`.
- **Bun**: the install cache (`BUN_INSTALL_CACHE_DIR`); Bun itself stays in
  the per-runner `~/.bun`.
- **Go**: `GOMODCACHE` and `GOCACHE`, shared by all runners (both are safe
  for concurrent use).
- **Docker**: images are built by the runners' Docker daemon itself (the
  default `docker` buildx driver), whose build cache persists (BuildKit GC
  on the daemon); the built image is removed from the daemon after the job.

The caches are keyed on content (cargo fingerprints and restored mtimes,
sccache hashes, Go build IDs, Bun's package store, BuildKit digests), so a
cache left by another branch is only less warm, never wrong. A job's code
can write into caches other jobs use; these are private repositories of one
team, the same trust the `green` markers already rely on.

GitHub-hosted runners (public repositories) use the Actions cache instead:
`Swatinem/rust-cache` (saved by `main` only), `actions/cache` for Bun,
`setup-go`'s cache, buildx with `type=gha`.

Cargo judges freshness by file mtime, and a checkout dates every file to the
checkout, so a kept target directory still rebuilt every workspace crate;
that is what `actions/source-mtimes` repairs.

Jobs that run cargo or `bun install` themselves get the same caches from
`actions/rust-cache` (a drop-in for `Swatinem/rust-cache`: `target/` becomes a
link to the lane) and `actions/bun-cache` (instead of an `actions/cache` step
on `~/.bun/install/cache`).

**Runner environment.** The runner container is Ubuntu 24.04 with the
usual build tools, git, jq, Python 3, the Docker CLI with buildx and compose,
`psql` and sccache; anything else comes from `setup-*` actions or
`sudo apt-get` (the job runs as root of the container, which is the
unprivileged `gh-ci` user on the host). Each job has the runner container's
own network namespace: 127.0.0.1 is the job's, the internet is reachable, the
dev box's LAN, Tailscale and host services are not (the host's
`traumbox_isolation` rules apply to all of `gh-ci`'s traffic). `docker` talks
to `gh-ci`'s rootless daemon. Containers a job
needs on its 127.0.0.1 join that namespace: `actions/postgres` does
(`--network container:$HOSTNAME`). `services:` with `ports:` do not work on
our runners (the ports are published on the host, which a job cannot reach);
use `actions/postgres` or `docker run --network container:$HOSTNAME`.
Containers a job starts with the label `gh-runner-job=$RUNNER_NAME` are
removed after it.

Container jobs (`container:`) work: the job container runs on the same
daemon beside the runner, without the runner's memory cap (set
`options: --memory 14g --memory-swap 14g`); `volumes:` with a named volume
keep a directory between jobs (a target directory, as Blacksmith's sticky
disks did).

Every input has a default; a step can be replaced by a command or skipped
with `""`.

## Bun, not Node

Every JavaScript/TypeScript project runs on Bun 1.4.4: `bun install`,
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

**`.github/workflows/ci.yml`**: on demand only (`gh workflow run ci.yml --ref
<branch>`), and as the first stage of a deploy or release, which calls it.
Nothing runs on its own for pull requests or pushes to `main`.

```yaml
name: ci

on:
  workflow_dispatch:
  workflow_call:              # deploy-production.yml / release.yml run it first

permissions:
  contents: read
  actions: read               # the "already passed" lookup

concurrency:
  group: ci-${{ github.sha }}
  cancel-in-progress: false

jobs:
  typescript:                 # or rust / go, one job per language or package
    uses: traumventures/ci/.github/workflows/typescript.yml@v1
  docker:                     # repositories with a Dockerfile: build check, no push
    uses: traumventures/ci/.github/workflows/docker.yml@v1
    with:
      image: my-service
```

**`.github/workflows/release.yml`**: publishes, on a tag `v<version>` (or a
manual dispatch). It runs `ci.yml` first; the gate only checks that the
commit is on `main`.

```yaml
name: release

on:
  push:
    tags: ["v*"]

permissions:
  contents: read
  actions: read

jobs:
  gate:                       # only a commit of main is published
    uses: traumventures/ci/.github/workflows/gate.yml@v1
    with: { await-ci: false }
  ci:                         # ... and only after its ci passed
    uses: ./.github/workflows/ci.yml
    secrets: inherit
  docker:
    needs: [gate, ci]
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
`deployment/cd/README.md` there), after a `gate` job (`gate.yml`,
`await-ci: false`) confirmed the commit is on `main` and a `ci` job (the
repository's `ci.yml`) passed for it. These run on their own deploy runners, not
on the shared pool.

Registry credentials: one Scaleway IAM application per repository
(`<repository>-publish`, `ContainerRegistryFullAccess` on the project), its
key as the repository secret `SCW_REGISTRY_PUSH_KEY`.

## Versions

Callers pin `@v1`. A compatible change moves the `v1` tag; a breaking one
starts `v2`.
