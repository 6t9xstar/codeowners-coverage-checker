# OwnerScope: GitHub CODEOWNERS validator and coverage checker

**Find files with no code owner, CODEOWNERS rules that match nothing or are silently overridden, and owners GitHub ignores. Then see who owns what, directory by directory.**

[![CI](https://github.com/6t9xstar/codeowners-coverage-checker/actions/workflows/ci.yml/badge.svg)](https://github.com/6t9xstar/codeowners-coverage-checker/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node.js](https://img.shields.io/badge/node-%3E%3D18.17-brightgreen)
![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)

CODEOWNERS fails silently. GitHub skips any line with invalid syntax, the *last* matching pattern wins (so a `*` at the bottom overrides everything above it), `docs/*` doesn't match nested files, paths are case-sensitive, and owners without write access are ignored. You only notice when a pull request merges without the review it needed.
**OwnerScope** applies GitHub's matching rules to every file in your repository and shows you the real result.

```bash
npx github:6t9xstar/codeowners-coverage-checker
```

## Example

Illustrative output for a mid-size monorepo (try it on [`fixtures/repo`](fixtures/repo/.github/CODEOWNERS)):

```text
OWNERSCOPE REPORT

CODEOWNERS:        .github/CODEOWNERS
Total files:       850
Covered files:     710
Uncovered files:   140

Invalid rules:     2
Unmatched rules:   3
Shadowed rules:    4

Ownership coverage: 83.5%

[WARNING] 96 file(s) in packages/ have no code owner (e.g. packages/ui/button.tsx, ...).
          OS006 .github/CODEOWNERS  Fix: /packages/ @owner
[WARNING] "/src/api/" matches 212 file(s), but later rules override all of them (e.g. "*" on line 14).
          The last matching rule wins.
          OS004 .github/CODEOWNERS:5  Fix: move "*" to the top of the file
[WARNING] "/infra/" matches no files.
          OS003 .github/CODEOWNERS:9  Fix: paths are case-sensitive: it would match "Infra/main.tf" with different casing
[ERROR]   Invalid owner "bob-without-at": owners must be @user, @org/team or an email address.
          GitHub ignores the whole line.
          OS002 .github/CODEOWNERS:10
[ERROR]   Negation patterns (!) are not supported in CODEOWNERS; the line is ignored.
          OS002 .github/CODEOWNERS:11
```

### Ownership by directory

```text
$ ownerscope coverage --depth 2
OWNERSHIP BY DIRECTORY
(repository)                          850 files   83.5%  @acme/maintainers, @acme/backend, @acme/web
  .github/                             14 files  100.0%  @acme/platform
  docs/                                88 files  100.0%  @acme/docs
  packages/                            96 files    0.0%
  src/                                612 files   97.9%  @acme/backend, @acme/web
    src/api/                          212 files  100.0%  @acme/backend
    src/web/                          387 files  100.0%  @acme/web
```

`ownerscope who src/api/server.ts` tells you which line owns a file:

```text
src/api/server.ts  @acme/backend @alice  .github/CODEOWNERS:5 /src/api/
```

## What it checks

- **Coverage**: every tracked and untracked (not ignored) file is matched with GitHub's semantics. Uncovered files are grouped by directory with a ready-to-paste rule. `--fail-under 95` turns coverage into a CI gate.
- **Unmatched rules**: patterns that match no file, with a hint when only the letter case is wrong.
- **Shadowed rules**: rules whose every file is overridden by a later rule, with the line that overrides them.
- **Duplicate patterns**, **duplicate owners**, and patterns with no owners (explicitly unowned).
- **Syntax GitHub doesn't support**: `!negation`, `[a-z]` ranges, and invalid owners (which make GitHub skip the whole line).
- **File location**: `.github/CODEOWNERS`, `CODEOWNERS` and `docs/CODEOWNERS` precedence, multiple files, and the 3 MB size limit.
- **GitHub API validation** (`--github`): GitHub's own CODEOWNERS error report (unknown users and teams, syntax), plus `--check-access` to verify that every user and team has **write** access.

## Install

Requires Node.js 18.17+ and git.

```bash
npx github:6t9xstar/codeowners-coverage-checker              # run once
npm install -g github:6t9xstar/codeowners-coverage-checker   # installs the ownerscope command
```

## Usage

```bash
ownerscope                                 # validate + coverage summary
ownerscope coverage --depth 3              # ownership tree
ownerscope coverage --list-uncovered       # every file without an owner
ownerscope who src/app.ts docs/index.md    # which rule owns these files
ownerscope --fail-under 90                 # CI gate
GITHUB_TOKEN=... ownerscope --github --check-access
ownerscope rules
```

| Option | Description |
| --- | --- |
| `--root <dir>` | Repository root (default `.`) |
| `--codeowners <file>` | Use a specific CODEOWNERS file |
| `--fail-under <pct>` | Fail when coverage is below the percentage |
| `--depth <n>` | Depth of the ownership tree (default 2) |
| `--list-uncovered` | List every uncovered file |
| `--github` | Validate with the GitHub API (`--repo owner/repo`, `--ref branch`) |
| `--check-access` | With `--github`: verify write access for every owner (needs `GITHUB_TOKEN`) |
| `-f, --format` | `text`, `json`, `sarif`, `markdown`, `github` |
| `--fail-on <level>` | `error` (default), `warning`, `info`, `none` |
| `--ignore <ids>` | Skip rules, e.g. `--ignore OS006,OS009` |

## GitHub Action

```yaml
name: CODEOWNERS
on:
  pull_request:
jobs:
  ownerscope:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: 6t9xstar/codeowners-coverage-checker@v1
        with:
          fail-under: 95
          github-validation: true   # uses the workflow's GITHUB_TOKEN
```

The job summary shows a coverage table per directory, and problems appear as annotations on the CODEOWNERS file.

> Without a token (or with a token that cannot see your organization's teams), GitHub reports private teams as unknown owners.

## Matching rules (how GitHub reads CODEOWNERS)

| Pattern | Matches |
| --- | --- |
| `*` | every file |
| `*.js` | `.js` files anywhere |
| `/docs/` | everything inside the root `docs` folder |
| `docs/` / `apps/` | a `docs` / `apps` folder **anywhere** in the tree |
| `docs/*` | files directly in `docs/`, **not** `docs/guide/setup.md` |
| `docs/**` | everything below `docs/` |
| `**/logs` | a `logs` file or folder anywhere |
| `!pattern`, `[abc]` | not supported: the line is skipped |

The **last** matching line wins, and paths are case-sensitive.

## Rules

| Rule | Severity | Description |
| --- | --- | --- |
| OS001 | error | No CODEOWNERS file |
| OS002 | error | Unsupported syntax or invalid owner (line ignored by GitHub) |
| OS003 | warning | Pattern matches no files |
| OS004 | warning | Rule fully overridden by later rules |
| OS005 | warning | Duplicate pattern |
| OS006 | warning | Files without a code owner |
| OS007 | warning | Multiple CODEOWNERS files |
| OS008 | error | CODEOWNERS larger than 3 MB |
| OS009 | info | Pattern without owners |
| OS010 | info | Email owner |
| OS011 | info | Owner listed twice on a line |
| OS012 | error | Error reported by the GitHub API (unknown owner, no write access, ...) |
| OS013 | error | Coverage below `--fail-under` |

## FAQ

### Why is CODEOWNERS not requesting reviews?

Common causes: the line has invalid syntax (GitHub skips it), a later rule such as `*` overrides it, the path's letter case doesn't match, or the user/team lacks write access. `ownerscope --github --check-access` checks all four.

### How do I check CODEOWNERS coverage?

Run `ownerscope coverage`. It shows the percentage of files with an owner overall and per directory; `--list-uncovered` prints every file without one.

### What is the difference between `/docs/` and `docs/*`?

`/docs/` matches everything inside the root `docs` folder at any depth. `docs/*` only matches files directly inside `docs/`, so `docs/guide/setup.md` is not covered.

### Does OwnerScope send my code anywhere?

No. Everything runs locally. Only the optional `--github` mode calls the GitHub API, sending the repository name and owner names.

## More developer tools

- [ScriptPort](https://github.com/6t9xstar/npm-scripts-cross-platform-checker): cross-platform npm scripts checker
- [ComposeDoctor](https://github.com/6t9xstar/docker-compose-doctor): Docker Compose validator and troubleshooter
- [CachePilot](https://github.com/6t9xstar/github-actions-cache-optimizer): GitHub Actions cache analyzer and optimizer
- [DevContainer Doctor](https://github.com/6t9xstar/devcontainer-json-validator): devcontainer.json validator
- [OwnerScope](https://github.com/6t9xstar/codeowners-coverage-checker): CODEOWNERS validator and coverage checker

## License

[MIT](LICENSE)
