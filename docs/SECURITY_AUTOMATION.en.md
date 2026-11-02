# Security automation

This document describes the versioned workflows and the limits of hosted evidence. A workflow's presence does not
prove it ran successfully.

| Workflow                | Push         | Pull request  | `workflow_dispatch` / schedule      | Configuration dependencies                                                                                           |
| ----------------------- | ------------ | ------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `ci.yml`                | All branches | All branches  | Manual dispatch; no schedule        | No external setting declared in YAML. Rulesets/branch protection that require its job depend on repository settings. |
| `codeql.yml`            | `main`       | Target `main` | Manual dispatch and weekly schedule | Alert publication depends on effective workflow permissions and platform settings.                                   |
| `dependency-review.yml` | —            | Target `main` | —                                   | Runs only for a real PR; rulesets may require its result as a status check.                                          |
| `pages.yml`             | `main`       | —             | Manual dispatch                     | Pages must be enabled with Source = GitHub Actions; deployment also depends on effective Pages permissions.          |

Trivy and SBOM generation/upload are steps in `ci.yml`; they run when CI is triggered and reaches those steps. Dependabot is a weekly configuration in `.github/dependabot.yml`, not a GitHub Actions workflow in this repository. YAML confirms only declared triggers and steps; it does not prove a hosted run or result. Rulesets and the Pages setting are not versioned here and must be checked in repository settings.

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
