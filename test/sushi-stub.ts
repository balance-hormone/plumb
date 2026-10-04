// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SYNTHETIC = join(import.meta.dirname, 'fixtures/profiles/fsh-generated/resources');

/** What the stub SUSHI does when run. */
interface StubBehaviour {
  /** The version its package.json declares. */
  version?: string;
  /** Lines it prints, in SUSHI's own format. */
  log?: string[];
  exitCode?: number;
  /** Copies Plumb's synthetic profiles into its output, as a build of them would. */
  build?: boolean;
}

/**
 * A SUSHI project with a stub `fsh-sushi` installed beside it: SUSHI needs the
 * FHIR registry for its own dependencies, so the tests of Plumb's side of the
 * contract (how it finds SUSHI, its arguments, its output and its log) run
 * offline against this. The stub records its arguments in `argv.json`.
 */
export function sushiProject(behaviour: StubBehaviour = {}): {
  root: string;
  argv: () => string[];
} {
  const root = mkdtempSync(join(tmpdir(), 'plumb-fsh-'));
  writeFileSync(join(root, 'sushi-config.yaml'), 'canonical: http://example.org/fhir/plumb-test\n');
  const pkg = join(root, 'node_modules', 'fsh-sushi');
  mkdirSync(join(pkg, 'dist'), { recursive: true });
  writeFileSync(
    join(pkg, 'package.json'),
    JSON.stringify({
      name: 'fsh-sushi',
      version: behaviour.version ?? '3.20.1',
      bin: { sushi: 'dist/app.js' },
    }),
  );
  writeFileSync(join(root, 'stub.json'), JSON.stringify({ ...behaviour, synthetic: SYNTHETIC }));
  writeFileSync(
    join(pkg, 'dist', 'app.js'),
    `const { cpSync, readFileSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const args = process.argv.slice(2);
const project = resolve(args[1]);
const stub = JSON.parse(readFileSync(join(project, 'stub.json'), 'utf8'));
writeFileSync(join(project, 'argv.json'), JSON.stringify(args));
const o = args.indexOf('-o');
// As SUSHI does: -o names the folder that gets fsh-generated/, the project by default.
const out = o === -1 ? project : resolve(args[o + 1]);
if (stub.build) cpSync(stub.synthetic, join(out, 'fsh-generated', 'resources'), { recursive: true });
for (const line of stub.log ?? []) console.log(line);
process.exit(stub.exitCode ?? 0);
`,
  );
  return {
    root,
    argv: () => JSON.parse(readFileSync(join(root, 'argv.json'), 'utf8')) as string[],
  };
}

/** A SUSHI project with no SUSHI installed anywhere it can be resolved from. */
export function bareSushiProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'plumb-fsh-'));
  writeFileSync(join(root, 'sushi-config.yaml'), 'canonical: http://example.org/fhir/plumb-test\n');
  cpSync(SYNTHETIC, join(root, 'fsh-generated', 'resources'), { recursive: true });
  return root;
}
