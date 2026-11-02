# Security automation

This document describes the versioned workflows and the limits of hosted evidence. A workflow's presence does not
prove it ran successfully.

| Check             | Repository configuration                                                                                                                                                                     | Evidence limit                                                                           |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| CodeQL            | `.github/workflows/codeql.yml`: pushes and pull requests to `main`, weekly schedule and `workflow_dispatch`; analyzes JavaScript/TypeScript. The workflow requests `security-events: write`. | YAML inspected; CodeQL run for the final SHA is not confirmed.                           |
| Trivy             | `.github/workflows/ci.yml`: scans the image and repository for `HIGH`/`CRITICAL` vulnerabilities; generates a CycloneDX image SBOM. Artifacts include the SHA and run id.                    | Configuration inspected; hosted scans and uploads for the final SHA are not confirmed.   |
| Dependency Review | `.github/workflows/dependency-review.yml`: PRs targeting `main`; checkout does not persist credentials; fails from `low` severity.                                                           | Requires a real PR; no run for the final SHA was observed.                               |
| Dependabot        | `.github/dependabot.yml`: weekly checks for npm, Docker and GitHub Actions; limit of five open pull requests per ecosystem.                                                                  | Configuration inspected; this does not assert that alerts or pull requests were created. |

## Observed status on 2026-11-02

The public checks page for `37ff489977e817ecac98b9c86efc5ba9a5fe5932` said “There are no checks for this commit”; the
public Actions list inspected ended with runs for SHA `2a2fb182`. Those older results do not validate later HEADs. The
repository does not show which credential created the push or the repository's Actions settings, so the missing runs'
cause cannot be determined. No workflow in this repository commits or pushes back to the repository.

The main CI and CodeQL workflows now support `workflow_dispatch`, as well as `push` and `pull_request`. This allows a
manual run for a selected ref. Pushes made with `GITHUB_TOKEN` generally do not start new workflow runs; an automation
that pushes code and needs subsequent checks must use an authorized GitHub App/PAT token or dispatch the workflow
manually. Dependency Review still requires a pull request targeting `main`. None of these routes ran in this review
because no valid GitHub credential was available.

## How to review

Inspect the workflow files above and their run status in GitHub Actions. The CodeQL YAML does not define a fork-specific
exception; GitHub platform permissions and limitations still apply. On a pull request to `main`, also review the
Dependency Review result.

Do not treat the local configuration as proof that the actions, permissions, result uploads or blocking rules worked
on a hosted runner. Confirm these in a real push or pull request run before reporting that the checks passed.
