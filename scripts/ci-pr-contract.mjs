// Mechanical PR hygiene only: never assert independent SDD review from a CI check.
import { readFileSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function inspectPr(event) {
  const errors = [];
  const warnings = [];
  const pr = event?.pull_request;
  if (!pr || pr.base?.ref !== 'develop') return { errors, warnings, skipped: true };
  if (event?.sender?.login === 'dependabot[bot]') return { errors, warnings, skipped: true };

  const body = typeof pr.body === 'string' ? pr.body.trim() : '';
  const requirements = [
    ['a base commit SHA', /\b[a-f0-9]{40}\b/i],
    ['validation evidence', /\b(validation|validated|tests?|tested|CI|провер(ка|ено)|тест(ы|ов)?)\b/i],
    ['privacy/security impact', /\b(privacy|security|secrets?|confidential|vault|приватн|безопасност|конфиденциальност)/i],
    ['independent review status', /\b(review|reviewer|reviewed|ревью|реценз)/i],
  ];
  if (!body || body.includes('Describe bounded implementation, decisions and non-goals.')) {
    warnings.push('PR description must replace the template with actual handoff evidence.');
  }
  for (const [label, pattern] of requirements) {
    if (!pattern.test(body)) warnings.push(`Missing ${label} in PR description.`);
  }
  // Draft candidates may be incomplete. Ready PRs must provide basic handoff metadata.
  if (!pr.draft) errors.push(...warnings);
  return { errors, warnings, skipped: false };
}

function run() {
  const eventPath = process.argv[2];
  if (!eventPath) throw new Error('Expected GITHUB_EVENT_PATH argument');
  const result = inspectPr(JSON.parse(readFileSync(eventPath, 'utf8')));
  if (result.skipped) return;
  for (const warning of result.warnings) {
    console.log(`::warning::${warning}`);
  }
  const summary = [
    '## Mechanical PR handoff preflight',
    `- State: ${result.errors.length ? 'FAIL' : 'PASS'}`,
    `- Findings: ${result.warnings.length}`,
    '- This is **not** an independent full-diff SDD review or merge authorization.',
    '',
  ].join('\n');
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  }
  if (result.errors.length) process.exitCode = 1;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) run();
