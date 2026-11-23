# Free GitHub security and PR hygiene checks (OKS)

## Scope and cost rule

This is a repository-operations hardening change, not a new OKS product capability or
an acceptance of any Gate A/B/C criterion. Applies to the public OKS repository only.
It uses GitHub-hosted Linux runners and security capabilities offered at no additional
cost for public GitHub repositories. It creates **zero GitHub AI Credits usage**;
no Copilot Chat/Review/cloud agent, AI Scan or agentic autofix is invoked.

GitHub may change product availability or pricing. Before activating any future
AI feature, verify that it does not debit AI Credits. **Classic Copilot Autofix**
for supported CodeQL alerts is different from billed **agentic autofix**;
this repository does not automatically request either kind of fix.

No CI job reads the production Vault, downloads model weights, sends source documents
to AI providers or requires secrets. The publicly committed code and dependency
manifest are processed by GitHub's hosted security infrastructure as part of public
repo analysis. Avoid introducing confidential code or fixtures.

## Triggers and coverage

| Control | Trigger | Decision |
|---|---|---|
| Existing `checks.yml` | push and PR | Current build/type/tests/licenses/package |
| `codeql.yml` | PR to develop, push develop, weekly, manual | CodeQL `security-extended`: JavaScript/TypeScript and Python, SARIF alerts |
| `dependency-review.yml` | PR to develop | Reject newly introduced high/critical vulnerable dependencies |
| `supply-chain.yml` | PR to develop, push develop, weekly, manual | `npm audit` committed lockfile, including dev dependencies; high/critical fail |
| `pr-quality.yml` | PR to develop, including ready/edit | Changed-file whitespace check; basic handoff metadata on Ready PR |
| `dependabot.yml` | **Only after it exists on default branch** | Weekly npm and GitHub Actions version-update PRs to develop |

The PR metadata validator checks presence of handoff text and does not verify truth
of assertions. Draft PRs get warnings; Ready PRs fail on missing metadata.
Dependabot-authored version-update PRs are exempt from this prose check but
still undergo dependency/security/test review. The independent full-diff review,
current exact HEAD CI evidence, and human-authorized merge defined in
`docs/development/SDD.md` **remain mandatory**.

The repository's default branch is presently `main`, and SDD development PRs
target `develop`. GitHub only activates `dependabot.yml` from the default
branch; adding the file to `develop` is therefore a **staged configuration**,
not an assertion that version-update PRs are already active. Promoting it to
`main` needs a separate explicit stable-branch decision. Dependabot security
alerts and security-update PRs use the default branch (main), regardless of
`target-branch: develop`. Do not merge Dependabot security PRs into main
outside the project's release process. The develop-specific npm audit and
dependency-review checks protect in-flight development independently.

Python here uses standard-library tests, with no committed pip/uv/Poetry
lockfile; no Python dependency-update ecosystem is configured.

## Repository security settings (non-versioned)

On 2026-11-24 the repository administrator enabled **Dependabot alerts** and
**Dependabot security updates** via GitHub's documented repository API. GitHub
confirmed HTTP 204 for vulnerability-alerts and HTTP 200 for automated-security-fixes;
repository metadata reports `dependabot_security_updates.status=enabled`. Both
features are separate from the staged `dependabot.yml`. Security updates target
default `main`; leave their PRs unmerged until reviewed under SDD.

Provider-pattern Secret Scanning and Push Protection were already enabled in this
public repository and remain enabled after the change. Do not enable billed
AI-detected secret patterns or AI Scan by accident. CodeQL uses **advanced
workflow setup**, not simultaneous default setup, to cover PRs targeting develop.

## Verification

1. On a PR to develop, check the existing validation, CodeQL (two languages),
   Dependency review, Dependency audit and PR hygiene jobs.
2. Confirm Code Scanning alerts are accessible after the first CodeQL run.
3. Verify repository security settings and Dependabot alerts separately.
4. For existing and changed code, review legitimate high/critical findings.
5. Do not treat a green CI or classic Autofix suggestion as a substitute for
   the separate-chat independent review and exact-head merge gates.

For rollback, revert the CI/configuration PR; separately disable repository
Dependabot toggles if those were enabled. Reverting workflows does not delete
existing security alerts.
