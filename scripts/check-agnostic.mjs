// Enforces the "agnostic, always" and "synthetic data only" rules. URL hosts
// are allow-listed so an organization's domain fails without this file naming
// it. Organization-specific terms come from PLUMB_DENYLIST (comma-separated),
// kept in a CI secret and your shell, because committing them would break the
// rule they enforce.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const allowedHosts = [
  'localhost',
  '127.0.0.1',
  'example.com',
  'example.org',
  'example.net',
  'hl7.org',
  'medplum.com',
  'apache.org',
  'github.com',
  'npmjs.com',
  'biomejs.dev',
  'turbo.build',
  'unpkg.com',
  'snomed.info',
  'loinc.org',
  'unitsofmeasure.org',
  'nlm.nih.gov',
];
const skipFiles = new Set(['package-lock.json']);

// biome-ignore lint/suspicious/noUndeclaredEnvVars: runs from npm directly, not through turbo.
const denylist = (process.env.PLUMB_DENYLIST ?? '')
  .split(',')
  .map((term) => term.trim())
  .filter(Boolean)
  .map(
    (term) =>
      new RegExp(`(?<![a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9])`, 'i'),
  );

const isAllowedHost = (host) =>
  allowedHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));

function violations(line) {
  const found = [];
  for (const [, host] of line.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) {
    if (!isAllowedHost(host.toLowerCase())) found.push(`URL host not allow-listed: ${host}`);
  }
  for (const [email, host] of line.matchAll(/[\w.%+-]+@((?:[a-z0-9-]+\.)+[a-z]{2,})\b/gi)) {
    if (!/^example\.(com|org|net)$/i.test(host)) found.push(`email outside example.*: ${email}`);
  }
  if (/\b\d{3}-\d{2}-\d{4}\b/.test(line)) found.push('SSN-shaped number');
  for (const term of denylist) {
    if (term.test(line)) found.push('organization-specific term (PLUMB_DENYLIST)');
  }
  return found;
}

let failures = 0;
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0');
for (const file of files.filter((f) => f && !skipFiles.has(f))) {
  const text = readFileSync(file, 'utf8');
  if (text.includes('\0')) continue;
  for (const [index, line] of [file, ...text.split('\n')].entries()) {
    for (const message of violations(line)) {
      console.error(index === 0 ? `${file}: (path) ${message}` : `${file}:${index}: ${message}`);
      failures++;
    }
  }
}
if (failures > 0) {
  console.error(`\n${failures} agnostic-check failure(s).`);
  process.exit(1);
}
console.log(`Agnostic check passed (${denylist.length} denylist term(s)).`);
