import type { RiskSeverity } from '@devdigest/shared';

/**
 * Deterministic risk rules. NO model is involved: every chip the UI shows is
 * something the diff literally contains, which is why each one carries the
 * `file_refs` that produced it.
 *
 * A rule fires on PATH alone. Content-derived risks (a new dependency's name)
 * are handled separately in `helpers.ts`, because they need the patch text and
 * produce one risk per match rather than one per rule.
 *
 * Adding a rule = adding a row here. Deliberately conservative: a chip that
 * fires on every PR is a chip a reviewer stops reading.
 */
export interface PathRule {
  kind: string;
  /** i18n-free title — the UI renders this string as-is. */
  title: string;
  explanation: string;
  severity: RiskSeverity;
  /** Matched against the lower-cased repo-relative path. */
  pattern: RegExp;
}

export const PATH_RULES: PathRule[] = [
  {
    kind: 'auth_surface',
    title: 'Auth surface touched',
    explanation:
      'This PR changes files on the authentication or authorization path, where a mistake ' +
      'affects who can reach the system rather than only what it does.',
    severity: 'high',
    pattern: /(^|\/)(auth|authn|authz|session|login|permission|credential)s?[./]|\bmiddleware\b/,
  },
  {
    kind: 'secrets_handling',
    title: 'Secrets handling touched',
    explanation:
      'A file that reads or stores secrets/tokens changed. Worth checking nothing was ' +
      'moved into source control or written to a log.',
    severity: 'high',
    pattern: /(^|\/)(secrets?|vault|keystore)[./]|\.env(\.|$)/,
  },
  {
    kind: 'db_migration',
    title: 'Database migration',
    explanation:
      'This PR adds or edits a migration. Migrations are not applied on boot in this ' +
      'project, so a deploy needs an explicit run.',
    severity: 'medium',
    pattern: /(^|\/)migrations?\//,
  },
  {
    kind: 'ci_workflow',
    title: 'CI workflow changed',
    explanation:
      'Build or CI configuration changed, which affects what gets verified before merge.',
    severity: 'medium',
    pattern: /(^|\/)\.github\/workflows\//,
  },
];

/** Manifests whose added dependency lines produce a "New dependency" risk. */
export const DEPENDENCY_MANIFESTS = ['package.json'];

/** Cap on dependency chips, so a lockfile-sized bump cannot flood the card. */
export const MAX_DEPENDENCY_RISKS = 6;
