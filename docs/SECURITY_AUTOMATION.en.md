# Security automation

This document describes the versioned workflows and the limits of hosted evidence. A workflow's presence does not
prove it ran successfully.

| Check             | Repository configuration                                                                                                                                                                     | Evidence limit                                                                                               |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| CodeQL            | `.github/workflows/codeql.yml`: pushes and pull requests to `main`, weekly schedule and `workflow_dispatch`; analyzes JavaScript/TypeScript. The workflow requests `security-events: write`. | YAML inspected; CodeQL run for the final SHA is not confirmed.                                               |
| Trivy             | `.github/workflows/ci.yml`: scans the API image and repository for `HIGH`/`CRITICAL` vulnerabilities; generates a CycloneDX SBOM for the API image. Artifacts include the SHA and run id.    | The protected edge Nginx image is not scanned; hosted scans and uploads for the final SHA are not confirmed. |
| Dependency Review | `.github/workflows/dependency-review.yml`: PRs targeting `main`; checkout does not persist credentials; fails from `low` severity.                                                           | Requires a real PR; no run for the final SHA was observed.                                                   |
| Dependabot        | `.github/dependabot.yml`: weekly checks for npm, Docker and GitHub Actions; limit of five open pull requests per ecosystem.                                                                  | Configuration inspected; this does not assert that alerts or pull requests were created.                     |

## Observed status on 2026-11-02

The public checks page for `37ff489977e817ecac98b9c86efc5ba9a5fe5932` said “There are no checks for this commit”; the
inspected list ended with runs for SHA `2a2fb182`. Later, the push of `47617e76f5c44507a92e7a6fe80b1a2403bd40ca` to
`main` was accepted, but that commit's public checks page also said “There are no checks for this commit”. The later
commit `2284a9d3664c71126e2529368552a94fa635cace`, which updated this evidence, was also pushed and still had no public
checks. The versioned CI workflow declares an unfiltered `push` trigger and `workflow_dispatch`; no workflow in this repository
commits or pushes back. The exact cause of the missing run is unconfirmed.

The main CI and CodeQL workflows support `workflow_dispatch` as well as automatic triggers. In this review, `GH_TOKEN`
was rejected as invalid, `gh` had no authenticated session without that variable, and an explicit dispatch attempt
received `Forbidden` from `api.github.com`. Public `github.com` pages and the Git remote push were available. The push
actor or credential type and the repository's Actions settings could not be inspected; suppression of runs from
`GITHUB_TOKEN` pushes is a possibility, not a confirmed cause. Dependency Review still requires a pull request
targeting `main`. No hosted result for published SHA `2284a9d` was observed for CI, CodeQL, Trivy, Dependency Review or
manual dispatch.

## How to review

Inspect the workflow files above and their run status in GitHub Actions. The CodeQL YAML does not define a fork-specific
exception; GitHub platform permissions and limitations still apply. On a pull request to `main`, also review the
Dependency Review result.

Do not treat the local configuration as proof that the actions, permissions, result uploads or blocking rules worked
on a hosted runner. Confirm these in a real push or pull request run before reporting that the checks passed.

### Release verification started at `44a793bcb09d72620660339186a046311b4e549a`

The [public checks page for this commit](https://github.com/dedeusgui/backend-challenge/commit/44a793bcb09d72620660339186a046311b4e549a/checks)
reported no checks. The versioned workflow declares `push` and `workflow_dispatch`; that confirms its configuration,
but does not explain the missing run. `gh run list` received `Forbidden` from `api.github.com` in this environment,
and no authenticated session was available to dispatch CI or CodeQL. Repository/organization Actions settings and the
push identity could not be inspected. Suppression due to `GITHUB_TOKEN` remains unproven.

A maintainer must run CI and CodeQL from **Actions → Run workflow** for the release SHA to produce hosted evidence;
Dependency Review requires a pull request targeting `main`. Until those runs exist, there is no hosted approval for
CI, Testcontainers, runtime smoke, protected mode, Trivy or CodeQL on that SHA.

### Status after the push

`main` was updated to `440fc2240cac979c28f68c268ecc295255cbf04b`. The [public checks page](https://github.com/dedeusgui/backend-challenge/commit/440fc2240cac979c28f68c268ecc295255cbf04b/checks)
says “There are no checks for this commit”; the [Actions list](https://github.com/dedeusgui/backend-challenge/actions)
shows no run for it. The push succeeded, but its identity could not be inspected. `GH_TOKEN` is invalid, and the
GitHub API is unavailable under this environment’s network allowlist. There is no evidence to attribute the missing
runs to `GITHUB_TOKEN` workflow suppression or disabled Actions settings.
