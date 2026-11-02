# Security automation

This document describes the workflows committed to the repository. A workflow's presence does not prove it ran
successfully. Hosted GitHub results and pull request runs were not executed or reviewed in this review.

| Check | Repository configuration | Evidence limit |
| --- | --- | --- |
| CodeQL | `.github/workflows/codeql.yml`: pushes and pull requests to `main`, plus a weekly schedule; analyzes JavaScript/TypeScript. For fork pull requests, analysis does not upload results to code scanning. | Configuration inspected; no hosted result was queried. |
| Trivy | `.github/workflows/ci.yml`: after building the API image, fails on `HIGH` or `CRITICAL` vulnerabilities. | Configuration inspected; the hosted runner scan was not executed in this review. |
| Dependency Review | `.github/workflows/dependency-review.yml`: pull requests to `main` when opened, synchronized or reopened; fails from `low` severity for runtime, development and unknown scopes; does not post a summary comment. | Configuration inspected; no pull request run was observed. |
| Dependabot | `.github/dependabot.yml`: weekly checks for npm, Docker and GitHub Actions; limit of five open pull requests per ecosystem. | Configuration inspected; this does not assert that alerts or pull requests were created. |

## How to review

Inspect the workflow files above and their run status in GitHub Actions. On a pull request, also review the Dependency
Review result and code scanning when the pull request comes from this repository. A fork pull request does not upload
CodeQL results to code scanning by explicit workflow configuration.

Do not treat the local configuration as proof that the actions, permissions, result uploads or blocking rules worked
on a hosted runner. Confirm these in a real push or pull request run before reporting that the checks passed.
