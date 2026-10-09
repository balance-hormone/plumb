// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { matchesSearchRequest, parseSearchRequest } from '@medplum/core';
import type { CodeableConcept, Observation, Resource } from '@medplum/fhirtypes';
import { isValidCron as medplumIsValidCron } from 'cron-validator';
import { describe, expect, test } from 'vitest';
import {
  checkBotFiles,
  checkCriteria,
  checkRoutes,
  defineConfig,
  environmentSettings,
  isValidCron,
  type LoadConfigResult,
  lockdownWarnings,
  type PlumbConfig,
  type ProjectConfig,
  resolveEnvironment,
  scopeConfig,
} from './config.js';
import { loadProfiles } from './loader.js';

const CONFIG_MODULE = join(import.meta.dirname, 'config.ts');
const TSX = dirname(createRequire(import.meta.url).resolve('tsx/package.json'));

// Vitest transforms TypeScript itself, so loading runs in a plain Node process
// to exercise Node's own type stripping, as the CLI will. With `tsx`, the
// project has tsx installed; `broken`, a tsx that throws when loaded, as
// tsx's esbuild does under a jsdom test environment.
function load(
  files: Record<string, string>,
  configPath?: string,
  options: { tsx?: boolean | 'broken' } = {},
): LoadConfigResult {
  const cwd = mkdtempSync(join(tmpdir(), 'plumb-config-'));
  writeFileSync(join(cwd, 'package.json'), '{ "type": "module" }');
  if (options.tsx === true) {
    mkdirSync(join(cwd, 'node_modules'));
    symlinkSync(TSX, join(cwd, 'node_modules', 'tsx'), 'dir');
  }
  if (options.tsx === 'broken') {
    const broken = join(cwd, 'node_modules', 'tsx');
    mkdirSync(broken, { recursive: true });
    writeFileSync(
      join(broken, 'package.json'),
      '{ "name": "tsx", "exports": { "./esm/api": "./api.cjs" } }',
    );
    writeFileSync(join(broken, 'api.cjs'), 'throw new Error("tsx loaded");');
  }
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, file)), { recursive: true });
    writeFileSync(join(cwd, file), text);
  }
  const script = `
    const { loadConfig } = await import(${JSON.stringify(CONFIG_MODULE)});
    console.log(JSON.stringify(await loadConfig(${JSON.stringify({ cwd, configPath })})));`;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return JSON.parse(out) as LoadConfigResult;
}

const VALID = `export default {
  igs: ['hl7.fhir.us.core@9.0.0'],
  profiles: ['http://hl7.org/fhir/us/core/StructureDefinition/us-core-patient'],
  local: './profiles',
  out: './src/fhir/generated',
};`;

function codes(result: LoadConfigResult): string[] {
  return result.ok ? [] : result.errors.map((e) => e.code);
}

describe('loadConfig', () => {
  test('loads plumb.config.ts from the working directory', () => {
    const result = load({ 'plumb.config.ts': VALID });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.igs).toEqual(['hl7.fhir.us.core@9.0.0']);
    expect(result.config.profiles).toEqual([
      'http://hl7.org/fhir/us/core/StructureDefinition/us-core-patient',
    ]);
    expect(result.config.out).toMatch(/[/\\]src[/\\]fhir[/\\]generated$/);
    expect(result.config.local).toMatch(/[/\\]profiles$/);
  });

  test('loads the path given, resolving paths against its folder', () => {
    const result = load({ 'config/custom.ts': VALID }, 'config/custom.ts');
    expect(result.ok && result.config.out).toMatch(/[/\\]config[/\\]src[/\\]fhir[/\\]generated$/);
  });

  test('allows TypeScript that Node strips, and omitting local', () => {
    const result = load({
      'plumb.config.ts': `import helper from './helper.ts';
        type Out = string;
        const out: Out = helper;
        export default { igs: [], profiles: [], out } satisfies Record<string, unknown>;`,
      'helper.ts': `export default './generated';`,
    });
    expect(result.ok).toBe(true);
    expect(result.ok && result.config.local).toBeUndefined();
  });

  test('fsh names a SUSHI project, whose output is the local folder', () => {
    const result = load({
      'plumb.config.ts': `export default { igs: [], profiles: [], fsh: './fsh', out: './out' };`,
      'fsh/sushi-config.yaml': 'canonical: http://example.org/fhir\n',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.fsh).toMatch(/[/\\]fsh$/);
    expect(result.config.local).toMatch(/[/\\]fsh[/\\]fsh-generated[/\\]resources$/);
  });

  test('fsh accepts sushi-config.yml, as SUSHI does', () => {
    const result = load({
      'plumb.config.ts': `export default { igs: [], profiles: [], fsh: './fsh', out: './out' };`,
      'fsh/sushi-config.yml': 'canonical: http://example.org/fhir\n',
    });
    expect(result.ok).toBe(true);
  });

  test('fsh-and-local, for both', () => {
    const result = load({
      'plumb.config.ts': `export default { igs: [], profiles: [], fsh: '.', local: './profiles', out: './out' };`,
      'sushi-config.yaml': 'canonical: http://example.org/fhir\n',
    });
    expect(codes(result)).toEqual(['fsh-and-local']);
  });

  test('no-sushi-config, for a folder without sushi-config.yaml', () => {
    const result = load({
      'plumb.config.ts': `export default { igs: [], profiles: [], fsh: './fsh', out: './out' };`,
    });
    expect(codes(result)).toEqual(['no-sushi-config']);
    expect(!result.ok && result.errors[0]?.message).toMatch(/sushi-config\.yaml/);
  });

  test('invalid-type, for an fsh that is not a path', () => {
    const result = load({
      'plumb.config.ts': `export default { igs: [], profiles: [], fsh: 1, out: './out' };`,
    });
    expect(codes(result)).toEqual(['invalid-type']);
  });

  test('config-not-found', () => {
    expect(codes(load({}))).toEqual(['config-not-found']);
  });

  test('unsupported-syntax, for an enum', () => {
    const result = load({
      'plumb.config.ts': `enum Dir { Out = './out' }
        export default { igs: [], profiles: [], out: Dir.Out };`,
    });
    expect(codes(result)).toEqual(['unsupported-syntax']);
  });

  test('unresolved-import, for a relative import without .ts', () => {
    const result = load({
      'plumb.config.ts': `import out from './helper';
        export default { igs: [], profiles: [], out };`,
      'helper.ts': `export default './out';`,
    });
    expect(codes(result)).toEqual(['unresolved-import']);
    expect(!result.ok && result.errors[0]?.message).toMatch(/\.ts/);
  });

  test('unresolved-import, for a tsconfig path alias', () => {
    const result = load({
      'plumb.config.ts': `import out from '@/helper';
        export default { igs: [], profiles: [], out };`,
    });
    expect(codes(result)).toEqual(['unresolved-import']);
    expect(!result.ok && result.errors[0]?.message).toMatch(/alias/);
  });

  // A workspace package that exports its TypeScript source, as written for a
  // bundler: extensionless imports, and installed under node_modules.
  const WORKSPACE = {
    'node_modules/@acme/policies/package.json': `{ "name": "@acme/policies", "type": "module", "exports": "./src/index.ts" }`,
    'node_modules/@acme/policies/src/index.ts': `import { dir } from './dir';
      export const out: string = dir;`,
    'node_modules/@acme/policies/src/dir.ts': `export const dir = './out';`,
    'tsconfig.json': `{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }`,
    'src/suffix.ts': `export const suffix = '/generated';`,
    'plumb.config.ts': `import { out } from '@acme/policies';
      import { suffix } from '@/suffix';
      enum Dir { Out = 'types' }
      export default { igs: [], profiles: [], out: out + suffix + '/' + Dir.Out };`,
  };

  test('with tsx installed, loads workspace TypeScript, path aliases and enums', () => {
    const result = load(WORKSPACE, undefined, { tsx: true });
    expect(result.ok && result.config.out).toMatch(/[/\\]out[/\\]generated[/\\]types$/);
  });

  test('with tsx installed, a config Node can load never loads tsx', () => {
    const result = load({ 'plumb.config.ts': VALID }, undefined, { tsx: 'broken' });
    expect(result.ok).toBe(true);
  });

  test('unsupported-syntax, for TypeScript under node_modules without tsx', () => {
    const result = load({
      ...WORKSPACE,
      'plumb.config.ts': `import { out } from '@acme/policies';
        export default { igs: [], profiles: [], out };`,
    });
    expect(codes(result)).toEqual(['unsupported-syntax']);
    expect(!result.ok && result.errors[0]?.message).toMatch(/node_modules.*tsx/);
  });

  test('unresolved-import with tsx installed, naming the import', () => {
    const result = load(
      {
        'plumb.config.ts': `import out from './missing';
          export default { igs: [], profiles: [], out };`,
      },
      undefined,
      { tsx: true },
    );
    expect(codes(result)).toEqual(['unresolved-import']);
    expect(!result.ok && result.errors[0]?.message).toMatch(/missing/);
  });

  test('no-default-export', () => {
    expect(codes(load({ 'plumb.config.ts': `export const out = './out';` }))).toEqual([
      'no-default-export',
    ]);
  });

  test('unknown-key, missing-out and invalid-type, all reported', () => {
    const result = load({
      'plumb.config.ts': `export default { igs: 'hl7.fhir.us.core@9.0.0', profiles: [], output: './out' };`,
    });
    expect(codes(result).sort()).toEqual(['invalid-type', 'missing-out', 'unknown-key']);
    expect(!result.ok && result.errors.map((e) => e.path).sort()).toEqual(['igs', 'out', 'output']);
  });

  test.each([
    'hl7.fhir.us.core',
    'hl7.fhir.us.core@',
    'hl7.fhir.us.core@^9.0.0',
    'hl7.fhir.us.core@9.0',
    'HL7.FHIR.US.CORE@9.0.0',
    '@scope/pkg@1.0.0',
  ])('invalid-ig: %s', (ig) => {
    const result = load({
      'plumb.config.ts': `export default { igs: [${JSON.stringify(ig)}], profiles: [], out: './out' };`,
    });
    expect(codes(result)).toEqual(['invalid-ig']);
    expect(!result.ok && result.errors[0]?.path).toBe('igs[0]');
  });

  test.each([
    'hl7.fhir.us.core@9.0.0',
    'hl7.fhir.uv.ips@2.0.0-ballot',
    'example.fhir.test-ig@0.1.0',
  ])('a valid IG: %s', (ig) => {
    const result = load({
      'plumb.config.ts': `export default { igs: [${JSON.stringify(ig)}], profiles: [], out: './out' };`,
    });
    expect(result.ok).toBe(true);
  });

  test('accepts every profile in a listed IG, as name/*', () => {
    const result = load({
      'plumb.config.ts': `export default {
        igs: ['hl7.fhir.us.core@9.0.0'],
        profiles: ['hl7.fhir.us.core/*', 'http://example.org/fhir/StructureDefinition/p'],
        out: './out',
      };`,
    });
    expect(result.ok && result.config.profiles).toEqual([
      'hl7.fhir.us.core/*',
      'http://example.org/fhir/StructureDefinition/p',
    ]);
  });

  test('unlisted-ig, for name/* naming an IG not in igs', () => {
    const result = load({
      'plumb.config.ts': `export default { igs: ['hl7.fhir.us.core@9.0.0'], profiles: ['hl7.fhir.uv.ips/*'], out: './out' };`,
    });
    expect(codes(result)).toEqual(['unlisted-ig']);
    expect(!result.ok && result.errors[0]?.path).toBe('profiles[0]');
  });

  test('accepts a value-set size limit', () => {
    const result = load({
      'plumb.config.ts': `export default { igs: [], profiles: [], out: './out', bindings: { maxCodes: 250 } };`,
    });
    expect(result.ok && result.config.bindings).toEqual({ maxCodes: 250 });
  });

  test.each([
    ['0', 'invalid-max-codes', 'bindings.maxCodes'],
    ['2.5', 'invalid-max-codes', 'bindings.maxCodes'],
    ["'100'", 'invalid-max-codes', 'bindings.maxCodes'],
  ])('invalid-max-codes: %s', (value, code, path) => {
    const result = load({
      'plumb.config.ts': `export default { igs: [], profiles: [], out: './out', bindings: { maxCodes: ${value} } };`,
    });
    expect(codes(result)).toEqual([code]);
    expect(!result.ok && result.errors[0]?.path).toBe(path);
  });

  test('check: tsconfig and baseline resolve against the config, ignore stays relative', () => {
    const result = load({
      'plumb.config.ts': `export default { igs: [], profiles: [], out: './out', check: { tsconfig: 'tsconfig.json', baseline: './plumb-check-baseline.json', ignore: ['**/*.test.ts'] } };`,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const base = dirname(result.configPath);
    expect(result.config.check).toEqual({
      tsconfig: [join(base, 'tsconfig.json')],
      baseline: join(base, 'plumb-check-baseline.json'),
      ignore: ['**/*.test.ts'],
    });
  });

  test.each([
    ['5', 'invalid-type', 'check'],
    ['{}', 'invalid-check', 'check.tsconfig'],
    ['{ tsconfig: [] }', 'invalid-check', 'check.tsconfig'],
    ["{ tsconfig: 'a.json', baseline: 5 }", 'invalid-check', 'check.baseline'],
    ["{ tsconfig: 'a.json', ignore: '*.ts' }", 'invalid-check', 'check.ignore'],
    ["{ tsconfig: 'a.json', tsc: 'b' }", 'unknown-key', 'check.tsc'],
  ])('check: %s', (value, code, path) => {
    const result = load({
      'plumb.config.ts': `export default { igs: [], profiles: [], out: './out', check: ${value} };`,
    });
    expect(!result.ok && result.errors.map((e) => [e.code, e.path])).toEqual([[code, path]]);
  });

  test('test: a server release, strict mode, features, settings and seed files', () => {
    const test = `{ server: '5.1.42', strictMode: false, features: ['bots'], settings: { intakeEnabled: true }, seed: ['./test/seed/*.json'] }`;
    const result = load({
      'plumb.config.ts': `export default { igs: [], profiles: [], out: './out', test: ${test} };`,
    });
    expect(result.ok && result.config.test).toEqual({
      server: '5.1.42',
      strictMode: false,
      features: ['bots'],
      settings: { intakeEnabled: true },
      // Resolved against the config's folder, keeping the glob.
      seed: [result.ok && join(dirname(result.configPath), 'test/seed/*.json')],
    });
  });

  test.each([
    ['5', 'invalid-type', 'test'],
    ["{ server: '^5.1.0' }", 'invalid-server-version', 'test.server'],
    ["{ server: 'latest' }", 'invalid-server-version', 'test.server'],
    ["{ strictMode: 'yes' }", 'invalid-type', 'test.strictMode'],
    ["{ features: 'bots' }", 'invalid-type', 'test.features'],
    ["{ seed: './seed.json' }", 'invalid-type', 'test.seed'],
    ['{ settings: { limit: {} } }', 'invalid-setting', 'test.settings.limit'],
    ['{ link: [] }', 'unknown-key', 'test.link'],
  ])('test: %s', (value, code, path) => {
    const result = load({
      'plumb.config.ts': `export default { igs: [], profiles: [], out: './out', test: ${value} };`,
    });
    expect(!result.ok && result.errors.map((e) => [e.code, e.path])).toEqual([[code, path]]);
  });

  test('content resolves against the config, keeping globs; anything but a list of paths is invalid-type', () => {
    const result = load({
      'plumb.config.ts': `export default { igs: [], profiles: [], out: './out', content: ['./fhir/content/*.json'] };`,
    });
    expect(result.ok && result.config.content).toEqual([
      result.ok && join(dirname(result.configPath), 'fhir/content/*.json'),
    ]);
    const invalid = load({
      'plumb.config.ts': `export default { igs: [], profiles: [], out: './out', content: './fhir/content' };`,
    });
    expect(!invalid.ok && invalid.errors.map((e) => [e.code, e.path])).toEqual([
      ['invalid-type', 'content'],
    ]);
  });

  test('unknown-key inside bindings, and bindings that is not an object', () => {
    const unknown = load({
      'plumb.config.ts': `export default { igs: [], profiles: [], out: './out', bindings: { max: 5 } };`,
    });
    expect(!unknown.ok && unknown.errors.map((e) => [e.code, e.path])).toEqual([
      ['unknown-key', 'bindings.max'],
    ]);
    const wrong = load({
      'plumb.config.ts': `export default { igs: [], profiles: [], out: './out', bindings: 5 };`,
    });
    expect(codes(wrong)).toEqual(['invalid-type']);
  });

  test.each([
    'us-core-patient',
    'http://hl7.org/fhir/us/core/StructureDefinition/us-core-patient|9.0.0',
    // The version lives in igs, and only the whole IG can be selected.
    'hl7.fhir.us.core@9.0.0/*',
    'hl7.fhir.us.core/us-core-*',
  ])('invalid-profile: %s', (profile) => {
    const result = load({
      'plumb.config.ts': `export default { igs: ['hl7.fhir.us.core@9.0.0'], profiles: [${JSON.stringify(profile)}], out: './out' };`,
    });
    expect(codes(result)).toEqual(['invalid-profile']);
  });

  test('accepts environments, naming the variables that hold the credentials', () => {
    const result = load({
      'plumb.config.ts': `export default { igs: [], profiles: [], out: './out', environments: {
        prod: { baseUrl: 'https://api.example.com/', clientId: { env: 'ID' }, clientSecret: { env: 'SECRET' } },
      } };`,
    });
    expect(result.ok && result.config.environments).toEqual({
      prod: {
        baseUrl: 'https://api.example.com/',
        clientId: { env: 'ID' },
        clientSecret: { env: 'SECRET' },
      },
    });
  });

  test.each(["'api.example.com'", "'ftp://api.example.com/'", "''", 'undefined'])(
    'invalid-base-url: %s',
    (baseUrl) => {
      const result = load({
        'plumb.config.ts': `export default { igs: [], profiles: [], out: './out', environments: {
          prod: { baseUrl: ${baseUrl}, clientId: { env: 'ID' }, clientSecret: { env: 'SECRET' } },
        } };`,
      });
      expect(!result.ok && result.errors.map((e) => [e.code, e.path])).toEqual([
        ['invalid-base-url', 'environments.prod.baseUrl'],
      ]);
    },
  );

  test('invalid-type, for a secret written into the config', () => {
    const result = load({
      'plumb.config.ts': `export default { igs: [], profiles: [], out: './out', environments: {
        prod: { baseUrl: 'https://api.example.com/', clientId: 'abc', clientSecret: { env: '' } },
      } };`,
    });
    expect(!result.ok && result.errors.map((e) => [e.code, e.path])).toEqual([
      ['invalid-type', 'environments.prod.clientId'],
      ['invalid-type', 'environments.prod.clientSecret'],
    ]);
    expect(!result.ok && result.errors[0]?.message).toMatch(/\{ env: 'VAR' \}/);
  });

  test('unknown-key inside an environment, and environments that are not objects', () => {
    const unknown = load({
      'plumb.config.ts': `export default { igs: [], profiles: [], out: './out', environments: {
        prod: { baseUrl: 'https://api.example.com/', clientId: { env: 'ID' }, clientSecret: { env: 'SECRET' }, project: 'x' },
      } };`,
    });
    expect(!unknown.ok && unknown.errors.map((e) => [e.code, e.path])).toEqual([
      ['unknown-key', 'environments.prod.project'],
    ]);
    const wrong = load({
      'plumb.config.ts': `export default { igs: [], profiles: [], out: './out', environments: { prod: 'https://api.example.com/' } };`,
    });
    expect(!wrong.ok && wrong.errors.map((e) => [e.code, e.path])).toEqual([
      ['invalid-type', 'environments.prod'],
    ]);
  });
});

const PLUMB = 'http://example.org/fhir/plumb-test/StructureDefinition';
const routed = (fields: string) =>
  load({
    'plumb.config.ts': `export default { igs: [], profiles: ['${PLUMB}/fixed-pattern-encounter'], out: './out', ${fields} };`,
  });
const paths = (result: LoadConfigResult) =>
  result.ok ? [] : result.errors.map((e) => [e.code, e.path]);

describe('routes and defaultProfile', () => {
  test('accepts routing rows, false, and defaults by resource type', () => {
    const result = routed(`
      routes: {
        '${PLUMB}/fixed-pattern-encounter': {
          class: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB' }],
          status: ['finished'],
        },
      },
      defaultProfile: { Encounter: ['https://example.org/fhir/StructureDefinition/org-encounter'] },`);
    expect(result.ok && result.config.routes).toEqual({
      [`${PLUMB}/fixed-pattern-encounter`]: {
        class: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB' }],
        status: ['finished'],
      },
    });
    expect(result.ok && result.config.defaultProfile).toEqual({
      Encounter: ['https://example.org/fhir/StructureDefinition/org-encounter'],
    });
    expect(routed(`routes: { '${PLUMB}/fixed-pattern-encounter': false }`).ok).toBe(true);
  });

  test('unselected-route, for a row naming a profile the config does not select', () => {
    expect(paths(routed(`routes: { '${PLUMB}/cardinality-patient': false }`))).toEqual([
      ['unselected-route', `routes["${PLUMB}/cardinality-patient"]`],
    ]);
  });

  test('invalid-route, for a row that is not a map of codings or code strings', () => {
    const url = `${PLUMB}/fixed-pattern-encounter`;
    expect(
      paths(
        routed(`routes: { '${url}': { class: [], status: [5], priority: [{ display: 'x' }] } }`),
      ),
    ).toEqual([
      ['invalid-route', `routes["${url}"].class`],
      ['invalid-route', `routes["${url}"].status`],
      ['invalid-route', `routes["${url}"].priority`],
    ]);
    expect(paths(routed(`routes: { '${url}': true }`))).toEqual([
      ['invalid-route', `routes["${url}"]`],
    ]);
    expect(paths(routed('routes: []'))).toEqual([['invalid-type', 'routes']]);
  });

  test('versioned-url, in a routing row or a default', () => {
    const url = `${PLUMB}/fixed-pattern-encounter|0.1.0`;
    expect(paths(routed(`routes: { '${url}': false }`))).toEqual([
      ['versioned-url', `routes["${url}"]`],
    ]);
    expect(paths(routed(`defaultProfile: { Encounter: ['${url}'] }`))).toEqual([
      ['versioned-url', 'defaultProfile.Encounter[0]'],
    ]);
  });

  test.each([
    ["['x']", 'defaultProfile'],
    ["{ encounter: ['https://example.org/p'] }", 'defaultProfile.encounter'],
    ["{ Encounter: 'https://example.org/p' }", 'defaultProfile.Encounter'],
    ['{ Encounter: [] }', 'defaultProfile.Encounter'],
  ])('invalid-default-profile: %s', (value, path) => {
    expect(paths(routed(`defaultProfile: ${value}`))).toEqual([['invalid-default-profile', path]]);
  });

  // Once profiles load: a wildcard's selection, and each profile's elements.
  describe('checkRoutes', () => {
    const loaded = loadProfiles({
      packages: [],
      igs: [],
      local: join(import.meta.dirname, '../test/fixtures/profiles/fsh-generated/resources'),
      profiles: [`${PLUMB}/fixed-pattern-encounter`, `${PLUMB}/choice-observation`],
    });

    test('accepts first-level elements, and a choice by its typed name', () => {
      expect(
        checkRoutes(
          {
            routes: {
              [`${PLUMB}/fixed-pattern-encounter`]: { class: [{ code: 'AMB' }] },
              [`${PLUMB}/choice-observation`]: { valueCodeableConcept: [{ code: 'x' }] },
            },
          },
          loaded.profiles,
        ),
      ).toEqual([]);
    });

    test('invalid-route-element, for a nested or unknown element', () => {
      const url = `${PLUMB}/fixed-pattern-encounter`;
      const errors = checkRoutes(
        { routes: { [url]: { 'class.code': ['AMB'], colour: ['red'], valueQuantity: ['1'] } } },
        loaded.profiles,
      );
      expect(errors.map((e) => [e.code, e.path])).toEqual([
        ['invalid-route-element', `routes["${url}"].class.code`],
        ['invalid-route-element', `routes["${url}"].colour`],
        ['invalid-route-element', `routes["${url}"].valueQuantity`],
      ]);
      expect(errors[1]?.message).toBe('"colour" is not a first-level element of Encounter.');
    });

    test('unselected-route, for a row no loaded profile matches', () => {
      expect(
        checkRoutes({ routes: { [`${PLUMB}/cardinality-patient`]: false } }, loaded.profiles).map(
          (e) => e.code,
        ),
      ).toEqual(['unselected-route']);
    });
  });
});

const PROJECT: ProjectConfig = {
  settings: { supportEmail: 'support@example.org', maxUploadMb: 25, ratio: 0.5, betaForms: false },
  secrets: { PAYMENT_API_KEY: { env: 'PAYMENT_API_KEY' }, LEGACY_SFTP_KEY: true },
  accessPolicies: {
    clinician: {
      resource: [
        { resourceType: 'Patient' },
        { resourceType: 'StructureDefinition', interaction: ['read', 'search'] },
      ],
    },
    'ci-deploy': { name: 'CI deploy', resource: [{ resourceType: 'StructureDefinition' }] },
  },
  defaultAccessPolicies: [{ profileType: 'Practitioner', accessPolicy: 'clinician' }],
  clients: { 'ci-deploy': { accessPolicy: 'ci-deploy', admin: true } },
};

const withProject = (project: string, environment = '') =>
  load({
    'plumb.config.ts': `export default { igs: [], profiles: [], out: './out', project: ${project}, environments: {
      prod: { baseUrl: 'https://api.example.com/', clientId: { env: 'ID' }, clientSecret: { env: 'SECRET' }${environment} },
    } };`,
  });

describe('project', () => {
  test("types a project block with Medplum's own shapes", () => {
    const config = defineConfig({ igs: [], profiles: [], out: './out', project: PROJECT });
    const reader = { resource: [{ resourceType: 'Patient', interaction: ['peek'] }] };
    // @ts-expect-error An AccessPolicy entry's interactions are Medplum's own.
    defineConfig({ ...config, project: { accessPolicies: { reader } } });
    // @ts-expect-error Only a super admin can write strictMode.
    defineConfig({ ...config, project: { strictMode: true } });
  });

  test('loads a valid project block, with per-environment settings', () => {
    const result = withProject(
      JSON.stringify(PROJECT),
      `, settings: { supportEmail: 'help@example.com' }`,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.project).toEqual(PROJECT);
    expect(environmentSettings(result.config, 'prod')).toEqual({
      ...PROJECT.settings,
      supportEmail: 'help@example.com',
    });
    expect(environmentSettings(result.config, 'staging')).toEqual(PROJECT.settings);
  });

  test('unknown-access-policy, from a client or a default access policy', () => {
    const result = withProject(`{
      accessPolicies: { clinician: {} },
      defaultAccessPolicies: [{ profileType: 'Practitioner', accessPolicy: 'nurse' }],
      clients: { ci: { accessPolicy: 'deploy' }, bot: { accessPolicy: 'toString' }, plain: {} },
    }`);
    expect(paths(result)).toEqual([
      ['unknown-access-policy', 'project.defaultAccessPolicies[0].accessPolicy'],
      ['unknown-access-policy', 'project.clients.ci.accessPolicy'],
      ['unknown-access-policy', 'project.clients.bot.accessPolicy'],
    ]);
    expect(!result.ok && result.errors[1]?.message).toMatch(/"deploy", which is not a key/);
  });

  test('duplicate-key, for two policies with one name or two defaults for one role', () => {
    const result = withProject(`{
      accessPolicies: { clinician: {}, nurse: { name: 'clinician' } },
      defaultAccessPolicies: [
        { profileType: 'Practitioner', accessPolicy: 'clinician' },
        { profileType: 'Practitioner', accessPolicy: 'nurse' },
      ],
    }`);
    expect(paths(result)).toEqual([
      ['duplicate-key', 'project.accessPolicies.nurse.name'],
      ['duplicate-key', 'project.defaultAccessPolicies[1].profileType'],
    ]);
  });

  test('invalid-setting, for a value that is not a string, boolean or number', () => {
    const result = withProject(
      `{ settings: { ok: 'yes', list: ['a'], nested: { a: 1 }, none: null, inf: Infinity } }`,
      `, settings: { url: { href: 'x' } }`,
    );
    expect(paths(result)).toEqual([
      ['invalid-setting', 'environments.prod.settings.url'],
      ['invalid-setting', 'project.settings.list'],
      ['invalid-setting', 'project.settings.nested'],
      ['invalid-setting', 'project.settings.none'],
      ['invalid-setting', 'project.settings.inf'],
    ]);
  });

  test('super-admin-field, for strictMode or features declared at all', () => {
    const result = withProject(`{ strictMode: true, features: [], secret: [] }`);
    expect(paths(result)).toEqual([
      ['super-admin-field', 'project.strictMode'],
      ['super-admin-field', 'project.features'],
      ['unknown-key', 'project.secret'],
    ]);
    expect(!result.ok && result.errors[0]?.message).toMatch(/super admin/);
  });

  test('invalid-type, for malformed secrets, policies, defaults and clients', () => {
    const result = withProject(`{
      secrets: { A: 'value', B: { env: '' }, C: false },
      accessPolicies: { clinician: [] },
      defaultAccessPolicies: [{ profileType: 'Device', accessPolicy: 'clinician' }],
      clients: { ci: { admin: 'yes', secret: 'x' } },
    }`);
    expect(paths(result)).toEqual([
      ['invalid-type', 'project.secrets.A'],
      ['invalid-type', 'project.secrets.B'],
      ['invalid-type', 'project.secrets.C'],
      ['invalid-type', 'project.accessPolicies.clinician'],
      ['invalid-type', 'project.defaultAccessPolicies[0].profileType'],
      ['unknown-key', 'project.clients.ci.secret'],
      ['invalid-type', 'project.clients.ci.admin'],
    ]);
    expect(!result.ok && result.errors[0]?.message).toMatch(/never holds the value/);
    expect(paths(withProject(`'prod'`))).toEqual([['invalid-type', 'project']]);
  });
});

const withBehaviour = (fields: string) =>
  load({
    'plumb.config.ts': `export default { igs: [], profiles: [], out: './out', project: {
      secrets: { SMS_API_KEY: { env: 'SMS_API_KEY' } },
      accessPolicies: { 'reminder-sender': {}, 'intake-writer': {} },
    }, ${fields} };`,
  });

const BEHAVIOUR = `
  bots: {
    'send-reminder': {
      file: './dist/bots/send-reminder.cjs',
      runtime: 'awslambda',
      timeout: 30,
      policy: 'reminder-sender',
      secrets: ['SMS_API_KEY'],
      cron: '0 14 * * *',
    },
    'intake-webhook': {
      file: './dist/bots/intake-webhook.cjs',
      name: 'Intake webhook',
      policy: 'intake-writer',
      publicWebhook: true,
      rawBody: true,
      audit: { trigger: 'on-error', destination: ['resource'] },
    },
  },
  subscriptions: {
    'new-appointment': {
      criteria: 'Appointment?status=booked',
      interactions: ['create'],
      bot: 'send-reminder',
    },
    'lab-result': {
      criteria: 'DiagnosticReport?status=final',
      fhirPath: "%previous.status != 'final'",
      url: 'https://hooks.example.org/lab',
      secret: { env: 'LAB_HOOK_SECRET' },
      headers: { Authorization: { env: 'LAB_HOOK_TOKEN' } },
      maxAttempts: 5,
    },
  },`;

describe('bots and subscriptions', () => {
  test("types bots and subscriptions with Medplum's own values", () => {
    const config = defineConfig({ igs: [], profiles: [], out: './out' });
    // @ts-expect-error A bot's audit trigger is one of the Bot's own.
    defineConfig({ ...config, bots: { a: { file: 'a.cjs', audit: { trigger: 'sometimes' } } } });
    const lab = { criteria: 'DiagnosticReport', url: 'https://example.org', secret: 'x' };
    // @ts-expect-error A secret names its variable: the config is committed.
    defineConfig({ ...config, subscriptions: { lab } });
  });

  test('loads bots and subscriptions, resolving each file against the config', () => {
    const result = withBehaviour(BEHAVIOUR);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const base = dirname(result.configPath);
    expect(result.config.bots?.['send-reminder']?.file).toBe(
      join(base, 'dist/bots/send-reminder.cjs'),
    );
    expect(result.config.subscriptions?.['lab-result']?.maxAttempts).toBe(5);
  });

  test('invalid-bot, naming the field and why', () => {
    const result = withBehaviour(`bots: {
      a: { file: './a.cjs', policy: 'nobody', secrets: ['SMS_API_KEY', 'MISSING'], cron: '0 25 * * *' },
      b: { file: './b.cjs', publicWebhook: true },
      c: { runtime: 'deno', timeout: 0, rawBody: 'yes', audit: { destination: ['email'] }, colour: 'red' },
      d: { file: './d.cjs', name: 'b' },
      e: { file: './e.cjs', name: 'd' },
      f: 'x',
      checker: { file: './checker.cjs' },
    }`);
    expect(paths(result)).toEqual([
      ['invalid-bot', 'bots.a.policy'],
      ['invalid-bot', 'bots.a.secrets[1]'],
      ['invalid-bot', 'bots.a.cron'],
      ['invalid-bot', 'bots.b.publicWebhook'],
      ['unknown-key', 'bots.c.colour'],
      ['invalid-bot', 'bots.c.file'],
      ['invalid-bot', 'bots.c.runtime'],
      ['invalid-bot', 'bots.c.timeout'],
      ['invalid-bot', 'bots.c.rawBody'],
      ['invalid-bot', 'bots.c.audit'],
      ['duplicate-key', 'bots.d.name'],
      ['invalid-type', 'bots.f'],
      ['invalid-bot', 'bots.checker'],
    ]);
    const messages = result.ok ? [] : result.errors.map((e) => e.message);
    expect(messages[0]).toMatch(/"nobody", which is not a key in project.accessPolicies/);
    expect(messages[1]).toMatch(/"MISSING", which is not a key in project.secrets/);
    expect(messages[3]).toMatch(/403/);
  });

  test('operations lists contract modules, resolved against the config; anything else is invalid-type', () => {
    const ok = withBehaviour(`operations: ['./src/operations/*.ts'],`);
    expect(ok.ok && ok.config.operations).toEqual([
      join(dirname(ok.configPath), 'src/operations/*.ts'),
    ]);
    expect(paths(withBehaviour(`operations: './src/operations'`))).toEqual([
      ['invalid-type', 'operations'],
    ]);
  });

  test('test.bots names a test build by key, resolved against the config', () => {
    const ok = withBehaviour(
      `${BEHAVIOUR} test: { bots: { 'send-reminder': { file: './test/reminder.cjs' } } },`,
    );
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.config.test?.bots?.['send-reminder']?.file).toBe(
      join(dirname(ok.configPath), 'test/reminder.cjs'),
    );
    const bad = withBehaviour(
      `${BEHAVIOUR} test: { bots: { nobody: { file: 'a.cjs' }, 'intake-webhook': 'b.cjs' } },`,
    );
    expect(paths(bad)).toEqual([
      ['unknown-bot', 'test.bots.nobody'],
      ['invalid-type', 'test.bots.intake-webhook'],
    ]);
  });

  test("policy entries name bots by key, or Plumb's checker: unknown-bot, or invalid-type off a Bot entry", () => {
    const result = load({
      'plumb.config.ts': `export default { igs: [], profiles: [], out: './out',
        bots: { echo: { file: './echo.cjs' } },
        project: { accessPolicies: {
          runner: { resource: [{ resourceType: 'Bot', bots: ['echo'] }] },
          migrator: { resource: [{ resourceType: 'Bot', bots: ['checker'] }] },
          stray: { resource: [{ resourceType: 'Bot', bots: ['echo', 'nobody'] }] },
          patient: { resource: [{ resourceType: 'Patient', bots: ['echo'] }] },
          both: { resource: [{ resourceType: 'Bot', criteria: 'Bot?name=echo', bots: ['echo'] }] },
        } },
      };`,
    });
    expect(paths(result)).toEqual([
      ['unknown-bot', 'project.accessPolicies.stray.resource[0].bots'],
      ['invalid-type', 'project.accessPolicies.patient.resource[0].bots'],
      ['invalid-type', 'project.accessPolicies.both.resource[0].bots'],
    ]);
    expect(!result.ok && result.errors[0]?.message).toMatch(/"nobody", which is not a key in bots/);
  });

  test('invalid-subscription, naming the field and why', () => {
    const result = withBehaviour(`bots: { 'send-reminder': { file: './a.cjs' } },
      subscriptions: {
        both: { criteria: 'Patient', bot: 'send-reminder', url: 'https://example.org/hook' },
        neither: { criteria: 'Patient' },
        unknown: { criteria: 'Patient', bot: 'nobody' },
        plain: { criteria: 'Patient', url: 'http://example.org/hook', maxAttempts: 19 },
        botOnly: { criteria: 'Patient', bot: 'send-reminder', secret: { env: 'X' } },
        chained: { criteria: 'Observation?subject.name=Smith', bot: 'send-reminder' },
        path: { criteria: 'Patient', fhirPath: "name.where(", bot: 'send-reminder' },
        headers: {
          criteria: 'Patient',
          url: 'https://example.org/hook',
          headers: { 'Bad: name': { env: 'A' }, Token: 'literal' },
        },
        events: { criteria: 'Patient', interactions: ['read'], bot: 'send-reminder', extra: 1 },
        missing: { bot: 'send-reminder' },
      }`);
    expect(paths(result)).toEqual([
      ['invalid-subscription', 'subscriptions.both'],
      ['invalid-subscription', 'subscriptions.neither'],
      ['invalid-subscription', 'subscriptions.unknown.bot'],
      ['invalid-subscription', 'subscriptions.plain.url'],
      ['invalid-subscription', 'subscriptions.plain.maxAttempts'],
      ['invalid-subscription', 'subscriptions.botOnly.secret'],
      ['invalid-subscription', 'subscriptions.chained.criteria'],
      ['invalid-subscription', 'subscriptions.path.fhirPath'],
      ['invalid-subscription', 'subscriptions.headers.headers["Bad: name"]'],
      ['invalid-subscription', 'subscriptions.headers.headers.Token'],
      ['unknown-key', 'subscriptions.events.extra'],
      ['invalid-subscription', 'subscriptions.events.interactions'],
      ['invalid-subscription', 'subscriptions.missing.criteria'],
    ]);
    const messages = result.ok ? [] : result.errors.map((e) => e.message);
    expect(messages[6]).toMatch(/can never fire: "subject.name" is chained/);
  });
});

// Each row's `match` is a resource FHIR search says the criteria select, and
// `miss` one it says they do not. A criteria fires when Medplum's matcher
// agrees on both; checkCriteria must accept exactly those.
const CRITERIA: { criteria: string; match: Resource; miss?: Resource; fires: boolean }[] = [
  {
    criteria: 'Appointment',
    match: { resourceType: 'Appointment', status: 'booked', participant: [] },
    fires: true,
  },
  {
    criteria: 'Appointment?status=booked',
    match: { resourceType: 'Appointment', status: 'booked', participant: [] },
    miss: { resourceType: 'Appointment', status: 'cancelled', participant: [] },
    fires: true,
  },
  {
    criteria: 'Observation?code=http://loinc.org|8867-4',
    match: observation({ code: coded('http://loinc.org', '8867-4') }),
    miss: observation({ code: coded('http://loinc.org', '8310-5') }),
    fires: true,
  },
  {
    criteria: 'Observation?code:not=http://loinc.org|8867-4',
    match: observation({ code: coded('http://loinc.org', '8310-5') }),
    miss: observation({ code: coded('http://loinc.org', '8867-4') }),
    fires: true,
  },
  {
    criteria: 'Observation?subject=Patient/1',
    match: observation({ subject: { reference: 'Patient/1' } }),
    miss: observation({ subject: { reference: 'Patient/2' } }),
    fires: true,
  },
  {
    criteria: 'Patient?name:contains=mit',
    match: { resourceType: 'Patient', name: [{ family: 'Smith' }] },
    miss: { resourceType: 'Patient', name: [{ family: 'Jones' }] },
    fires: true,
  },
  {
    criteria: 'Patient?birthdate=ge2000-01-01',
    match: { resourceType: 'Patient', birthDate: '2001-05-05' },
    miss: { resourceType: 'Patient', birthDate: '1999-05-05' },
    fires: true,
  },
  {
    criteria: 'Patient?_tag=http://example.org/tags|vip',
    match: {
      resourceType: 'Patient',
      meta: { tag: [{ system: 'http://example.org/tags', code: 'vip' }] },
    },
    miss: { resourceType: 'Patient' },
    fires: true,
  },
  {
    criteria: 'Observation?value-quantity:missing=true',
    match: observation({}),
    miss: observation({ valueQuantity: { value: 5 } }),
    fires: true,
  },
  {
    criteria: 'Unknown?status=final',
    match: { resourceType: 'Unknown', status: 'final' } as unknown as Resource,
    fires: false,
  },
  {
    criteria: 'Observation?subject.name=Smith',
    match: observation({ subject: { reference: 'Patient/1', display: 'Smith' } }),
    fires: false,
  },
  {
    criteria: 'Patient?_has:Observation:subject:code=8867-4',
    match: { resourceType: 'Patient', id: '1' },
    fires: false,
  },
  {
    criteria: 'Patient?x-favourite-colour=blue',
    match: {
      resourceType: 'Patient',
      extension: [{ url: 'x-favourite-colour', valueString: 'blue' }],
    },
    fires: false,
  },
  {
    criteria: 'RiskAssessment?probability=gt0.5',
    match: {
      resourceType: 'RiskAssessment',
      status: 'final',
      subject: { reference: 'Patient/1' },
      prediction: [{ probabilityDecimal: 0.8 }],
    },
    fires: false,
  },
  {
    criteria: 'Observation?value-quantity=gt5',
    match: observation({ valueQuantity: { value: 8 } }),
    fires: false,
  },
  {
    criteria: 'Observation?code-value-quantity=http://loinc.org|8480-6$gt100',
    match: observation({
      code: coded('http://loinc.org', '8480-6'),
      valueQuantity: { value: 120 },
    }),
    fires: false,
  },
  {
    criteria: 'Patient?name:exact=Smith',
    match: { resourceType: 'Patient', name: [{ family: 'Smith' }] },
    miss: { resourceType: 'Patient', name: [{ family: 'Smithson' }] },
    fires: false,
  },
  {
    criteria: 'Observation?code:text=Heart rate',
    match: observation({ code: { coding: [{ code: '8867-4', display: 'Heart rate, resting' }] } }),
    fires: false,
  },
  {
    criteria: 'Observation?code:in=http://example.org/ValueSet/vitals',
    match: observation({ code: coded('http://loinc.org', '8867-4') }),
    fires: false,
  },
  {
    criteria: 'Observation?subject:identifier=http://example.org/mrn|123',
    match: observation({
      subject: { identifier: { system: 'http://example.org/mrn', value: '123' } },
    }),
    fires: false,
  },
  {
    criteria: 'Patient?birthdate=ap2000-01-01',
    match: { resourceType: 'Patient', birthDate: '2000-01-02' },
    fires: false,
  },
  {
    criteria: 'Patient?birthdate=yesterday',
    match: { resourceType: 'Patient', birthDate: '2000-01-02' },
    fires: false,
  },
];

function observation(fields: Partial<Observation>): Observation {
  return { resourceType: 'Observation', status: 'final', code: { text: 'x' }, ...fields };
}

function coded(system: string, code: string): CodeableConcept {
  return { coding: [{ system, code }] };
}

const withScope = (fields: string) =>
  load({
    'plumb.config.ts': `export default { igs: [], profiles: [], out: './out',
      environments: {
        dev: { baseUrl: 'http://localhost:8103/', clientId: { env: 'ID' }, clientSecret: { env: 'SECRET' } },
        prod: { baseUrl: 'https://example.org/', clientId: { env: 'ID' }, clientSecret: { env: 'SECRET' } },
      },
      ${fields} };`,
  });

describe('environment scope', () => {
  test('loads trigger overrides and resolves only the selected environment without mutating defaults', () => {
    const result = withScope(`project: { accessPolicies: { sender: {} } }, bots: {
      sync: { file: './sync.cjs', policy: 'sender', cron: '0 3 * * *', publicWebhook: true,
        environmentOverrides: { prod: { cron: null, publicWebhook: false }, dev: { cron: '0 4 * * *' } } },
      draft: { file: './draft.cjs', environments: ['dev'], environmentOverrides: { prod: { cron: '0 5 * * *' } } },
    }`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const prod = scopeConfig(result.config, 'prod');
    expect(prod.config.bots?.sync?.cron).toBeUndefined();
    expect(prod.config.bots?.sync?.publicWebhook).toBe(false);
    expect(prod.config.bots?.sync).not.toHaveProperty('environmentOverrides');
    expect(prod.config.bots?.draft).toBeUndefined();
    const dev = scopeConfig(result.config, 'dev');
    expect(dev.config.bots?.sync?.cron).toBe('0 4 * * *');
    expect(dev.config.bots?.sync?.publicWebhook).toBe(true);
    expect(scopeConfig(result.config, 'other').config.bots?.sync?.cron).toBe('0 3 * * *');
    expect(result.config.bots?.sync?.cron).toBe('0 3 * * *');
    expect(result.config.bots?.sync?.publicWebhook).toBe(true);
  });

  test.each([
    ['{ qa: {} }', 'invalid-bot', 'environmentOverrides.qa'],
    ['{ prod: { timeout: 10 } }', 'unknown-key', 'environmentOverrides.prod.timeout'],
    ["{ prod: { cron: '0 25 * * *' } }", 'invalid-bot', 'environmentOverrides.prod.cron'],
    ['{ prod: { cron: false } }', 'invalid-bot', 'environmentOverrides.prod.cron'],
    ['{ prod: { publicWebhook: true } }', 'invalid-bot', 'environmentOverrides.prod.publicWebhook'],
    [
      "{ prod: { publicWebhook: 'yes' } }",
      'invalid-bot',
      'environmentOverrides.prod.publicWebhook',
    ],
    ['{ prod: null }', 'invalid-type', 'environmentOverrides.prod'],
    ['[]', 'invalid-bot', 'environmentOverrides'],
  ])('rejects invalid overrides %s at the field', (overrides, code, field) => {
    expect(
      paths(
        withScope(`bots: { sync: { file: './sync.cjs', environmentOverrides: ${overrides} } }`),
      ),
    ).toEqual([[code, `bots.sync.${field}`]]);
  });

  test('undefined trigger overrides inherit the base bot', () => {
    const config = defineConfig({
      igs: [],
      profiles: [],
      out: '',
      bots: {
        sync: {
          file: './sync.cjs',
          policy: 'sender',
          cron: '0 3 * * *',
          publicWebhook: true,
          environmentOverrides: { prod: { cron: undefined, publicWebhook: undefined } },
        },
      },
    });
    expect(scopeConfig(config, 'prod').config.bots?.sync).toMatchObject({
      cron: '0 3 * * *',
      publicWebhook: true,
    });
  });

  test('an override can add a trigger and empty overrides inherit defaults', () => {
    const result = withScope(`project: { accessPolicies: { sender: {} } }, bots: {
      sync: { file: './sync.cjs', policy: 'sender', environmentOverrides: {
        dev: { cron: '0 3 * * *', publicWebhook: true }, prod: {} } },
    }`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(scopeConfig(result.config, 'dev').config.bots?.sync).toMatchObject({
      cron: '0 3 * * *',
      publicWebhook: true,
    });
    expect(scopeConfig(result.config, 'prod').config.bots?.sync?.cron).toBeUndefined();
    expect(scopeConfig(result.config, 'prod').config.bots?.sync?.publicWebhook).toBeUndefined();
  });

  test('a scope names declared environments, and a Subscription goes no wider than its bot', () => {
    const result = withScope(`
      bots: {
        draft: { file: './draft.cjs', environments: ['dev'] },
        typo: { file: './typo.cjs', environments: ['staging'] },
        empty: { file: './empty.cjs', environments: [] },
      },
      subscriptions: {
        inherits: { criteria: 'Patient', bot: 'draft' },
        narrower: { criteria: 'Patient', bot: 'draft', environments: ['dev'] },
        wider: { criteria: 'Patient', bot: 'draft', environments: ['dev', 'prod'] },
        url: { criteria: 'Patient', url: 'https://example.org/hook', environments: ['qa'] },
      },`);
    expect(paths(result)).toEqual([
      ['invalid-bot', 'bots.typo.environments'],
      ['invalid-bot', 'bots.empty.environments'],
      ['invalid-subscription', 'subscriptions.wider.environments'],
      ['invalid-subscription', 'subscriptions.url.environments'],
    ]);
    const messages = result.ok ? [] : result.errors.map((e) => e.message);
    expect(messages).toContain(
      '"bots.typo.environments" names "staging", which is not a key in environments.',
    );
    expect(messages).toContain(
      '"subscriptions.wider.environments" includes "prod", where bot "draft" is not deployed.',
    );
  });

  test('a secret scope names declared environments', () => {
    const result = withScope(`
      project: { secrets: {
        DEV_ONLY: { env: 'DEV_ONLY', environments: ['dev'] },
        TYPO: { env: 'TYPO', environments: ['staging'] },
        NOT_A_LIST: { env: 'X', environments: 'dev' },
        EXTRA: { env: 'X', colour: 'red' },
      } },`);
    expect(paths(result)).toEqual([
      ['invalid-type', 'project.secrets.TYPO.environments'],
      ['invalid-type', 'project.secrets.NOT_A_LIST.environments'],
      ['unknown-key', 'project.secrets.EXTRA.colour'],
    ]);
  });

  test('scopeConfig leaves out a secret scoped to another environment', () => {
    const config: PlumbConfig = {
      igs: [],
      profiles: [],
      out: './out',
      project: {
        settings: { a: 'b' },
        secrets: {
          SHARED: { env: 'SHARED' },
          BY_HAND: true,
          ALLOWLIST: { env: 'ALLOWLIST', environments: ['dev'] },
        },
      },
    };
    const prod = scopeConfig(config, 'prod');
    expect(prod.config.project).toEqual({
      settings: { a: 'b' },
      secrets: { SHARED: { env: 'SHARED' }, BY_HAND: true },
    });
    expect(prod.out).toEqual([{ kind: 'Secret', key: 'ALLOWLIST', environments: ['dev'] }]);
    expect(scopeConfig(config, 'dev').config).toEqual(config);
  });

  test('migrations run in every environment, so their bot has no scope', () => {
    const result = withScope(`
      bots: { migrator: { file: './migrator.cjs', environments: ['dev'] } },
      migrations: { bot: 'migrator', modules: ['./m/*.ts'] },`);
    expect(paths(result)).toEqual([['invalid-migration', 'migrations.bot']]);
  });

  test('scopeConfig leaves out what an environment is not in, and says where it goes', () => {
    const config: PlumbConfig = {
      igs: [],
      profiles: [],
      out: './out',
      bots: {
        live: { file: 'live.cjs' },
        draft: { file: 'draft.cjs', environments: ['dev'] },
      },
      subscriptions: {
        toLive: { criteria: 'Patient', bot: 'live' },
        toDraft: { criteria: 'Patient', bot: 'draft' },
        devOnly: { criteria: 'Patient', bot: 'live', environments: ['dev'] },
        hook: { criteria: 'Patient', url: 'https://example.org/hook' },
      },
    };
    const prod = scopeConfig(config, 'prod');
    expect(Object.keys(prod.config.bots ?? {})).toEqual(['live']);
    expect(Object.keys(prod.config.subscriptions ?? {})).toEqual(['toLive', 'hook']);
    expect(prod.out).toEqual([
      { kind: 'Bot', key: 'draft', environments: ['dev'] },
      { kind: 'Subscription', key: 'toDraft', environments: ['dev'] },
      { kind: 'Subscription', key: 'devOnly', environments: ['dev'] },
    ]);
    const dev = scopeConfig(config, 'dev');
    expect(dev.config).toEqual(config);
    expect(dev.out).toEqual([]);
    // Nothing declared stays nothing, so push skips the step as before.
    expect(
      scopeConfig({ igs: [], profiles: [], out: './out' }, 'prod').config.bots,
    ).toBeUndefined();
  });
});

const withMigrations = (migrations: string, environment = '', files: Record<string, string> = {}) =>
  load({
    'plumb.config.ts': `export default { igs: [], profiles: [], out: './out',
      bots: { migrator: { file: './dist/migrator.cjs' } },
      migrations: ${migrations},
      environments: { dev: { baseUrl: 'http://localhost:8103/', clientId: { env: 'ID' }, clientSecret: { env: 'SECRET' }${environment} } } };`,
    ...files,
  });

describe('migrations', () => {
  test('loads migrations and synthetic, resolving each module pattern against the config', () => {
    const result = withMigrations(
      "{ bot: 'migrator', modules: ['./src/migrations/*.ts'], restamp: true }",
      ', synthetic: true',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.migrations).toEqual({
      bot: 'migrator',
      modules: [join(dirname(result.configPath), 'src/migrations/*.ts')],
      restamp: true,
    });
    expect(result.config.environments?.dev?.synthetic).toBe(true);
  });

  test.each([
    ["{ bot: 'other', modules: ['./m/*.ts'] }", 'invalid-migration', 'migrations.bot'],
    ["{ modules: ['./m/*.ts'] }", 'invalid-type', 'migrations.bot'],
    ["{ bot: 'migrator', modules: './m/*.ts' }", 'invalid-type', 'migrations.modules'],
    ["{ bot: 'migrator', modules: [] }", 'invalid-type', 'migrations.modules'],
    [
      "{ bot: 'migrator', modules: ['./m/*.ts'], restamp: 'yes' }",
      'invalid-type',
      'migrations.restamp',
    ],
    [
      "{ bot: 'migrator', modules: ['./m/*.ts'], restamp: { exclude: 3 } }",
      'invalid-type',
      'migrations.restamp.exclude',
    ],
    [
      "{ bot: 'migrator', modules: ['./m/*.ts'], restamp: { exclude: './x.ts', only: ['Coverage'] } }",
      'unknown-key',
      'migrations.restamp.only',
    ],
    [
      "{ bot: 'migrator', modules: ['./m/*.ts'], restamp: { exclude: './missing.ts' } }",
      'invalid-restamp-exclude',
      'migrations.restamp.exclude',
    ],
    ["{ bot: 'migrator', modules: ['./m/*.ts'], order: [] }", 'unknown-key', 'migrations.order'],
    ["['./m/*.ts']", 'invalid-type', 'migrations'],
  ])('%s is %s at %s', (migrations, code, path) => {
    const result = withMigrations(migrations);
    expect(!result.ok && result.errors.map((e) => [e.code, e.path])).toEqual([[code, path]]);
  });

  test("resolves the restamp's exclusion module against the config", () => {
    const result = withMigrations(
      "{ bot: 'migrator', modules: ['./m/*.ts'], restamp: { exclude: './m/never-stamped.ts' } }",
      '',
      { 'm/never-stamped.ts': 'export default () => undefined;' },
    );
    expect(result.ok && result.config.migrations?.restamp).toEqual({
      exclude: join(dirname(result.configPath), 'm/never-stamped.ts'),
    });
  });

  test('synthetic must be a boolean', () => {
    const result = withMigrations(
      "{ bot: 'migrator', modules: ['./m/*.ts'] }",
      ", synthetic: 'yes'",
    );
    expect(!result.ok && result.errors.map((e) => [e.code, e.path])).toEqual([
      ['invalid-type', 'environments.dev.synthetic'],
    ]);
  });
});

describe('checkCriteria', () => {
  test.each(CRITERIA)('$criteria', ({ criteria, match, miss, fires }) => {
    // checkCriteria first: it indexes the definitions Medplum's server does.
    const reason = checkCriteria(criteria);
    let matched = false;
    try {
      const request = parseSearchRequest(criteria);
      matched =
        matchesSearchRequest(match, request) && !(miss && matchesSearchRequest(miss, request));
    } catch {
      // Medplum skips a Subscription whose criteria it cannot parse.
    }
    expect(matched).toBe(fires);
    expect(reason === undefined).toBe(fires);
  });
});

describe('isValidCron', () => {
  test.each([
    '0 14 * * *',
    '*/15 * * * *',
    '0 0 1 1 *',
    '0 0 * * 0-6',
    ' 0  0 * * 1 ',
    '1-5/2 * * * *',
    '1,2,3 * * * *',
    '0 0 * * 7',
    '0 0 * * mon',
    '0 0 * jan *',
    '60 * * * *',
    '0 24 * * *',
    '0 0 0 * *',
    '0 0 32 * *',
    '0 0 * 13 *',
    '5-1 * * * *',
    '1,,2 * * * *',
    '*/0 * * * *',
    '*/ * * * *',
    '*/*/* * * * *',
    '? * * * *',
    '0 0 ? * *',
    '0 0 L * *',
    '0 0 * * 1#2',
    '* * * *',
    '* * * * * *',
    '',
  ])('%j as Medplum validates it', (cron) => {
    expect(isValidCron(cron)).toBe(medplumIsValidCron(cron));
  });
});

describe('checkBotFiles', () => {
  const dir = mkdtempSync(join(tmpdir(), 'plumb-bots-'));
  const file = (name: string, text: string) => {
    writeFileSync(join(dir, name), text);
    return join(dir, name);
  };
  const footer = file(
    'footer.cjs',
    'module.exports = { handler };\nObject.assign(exports, module.exports);\nasync function handler() {}',
  );
  const assigned = file(
    'assigned.js',
    'exports.handler = async () => { await Promise.resolve(); };',
  );
  const replaced = file('replaced.cjs', 'module.exports = { handler: async () => {} };');
  const esm = file('esm.js', 'export async function handler() {}');
  const mjs = file('bot.mjs', 'export async function handler() {}');

  test('accepts a CommonJS bundle that assigns exports.handler, and any bundle for Lambda', () => {
    expect(
      checkBotFiles({
        a: { file: footer, runtime: 'vmcontext' },
        b: { file: assigned, runtime: 'vmcontext' },
        c: { file: mjs },
        d: { file: replaced, runtime: 'awslambda' },
      }),
    ).toEqual([]);
  });

  test('invalid-bot, for a missing file or one vmcontext cannot run', () => {
    const errors = checkBotFiles({
      missing: { file: join(dir, 'missing.cjs') },
      esm: { file: esm, runtime: 'vmcontext' },
      mjs: { file: mjs, runtime: 'vmcontext' },
      replaced: { file: replaced, runtime: 'vmcontext' },
    });
    expect(errors.map((e) => [e.code, e.path])).toEqual([
      ['invalid-bot', 'bots.missing.file'],
      ['invalid-bot', 'bots.esm.file'],
      ['invalid-bot', 'bots.mjs.file'],
      ['invalid-bot', 'bots.replaced.file'],
    ]);
    expect(errors[0]?.message).toMatch(/does not exist/);
    expect(errors[1]?.message).toMatch(/not CommonJS/);
    expect(errors[3]?.message).toMatch(/Object.assign\(exports, module.exports\)/);
  });
});

describe('lockdownWarnings', () => {
  const warnings = (project: ProjectConfig, ownPolicy?: string) =>
    lockdownWarnings(project, ownPolicy).map((w) => [w.code, w.path]);

  test('none for a config that follows the lockdown recipe', () => {
    expect(warnings(PROJECT, 'ci-deploy')).toEqual([]);
  });

  test('writable-wildcard, for a * entry that is not read-only', () => {
    expect(
      warnings({
        accessPolicies: {
          open: { resource: [{ resourceType: '*' }] },
          reads: { resource: [{ resourceType: '*', readonly: true }] },
          searches: { resource: [{ resourceType: '*', interaction: ['read', 'search'] }] },
          deletes: { resource: [{ resourceType: '*', interaction: ['read', 'delete'] }] },
        },
      }),
    ).toEqual([
      ['writable-wildcard', 'project.accessPolicies.open.resource[0]'],
      ['writable-wildcard', 'project.accessPolicies.deletes.resource[0]'],
    ]);
  });

  test('admin-without-policy, for an admin client with no accessPolicy', () => {
    expect(
      warnings({
        accessPolicies: { deploy: {} },
        clients: { root: { admin: true }, ci: { admin: true, accessPolicy: 'deploy' }, app: {} },
      }),
    ).toEqual([['admin-without-policy', 'project.clients.root']]);
  });

  test("writes-structure-definition, for any policy but push's own", () => {
    expect(warnings(PROJECT)).toEqual([
      ['writes-structure-definition', 'project.accessPolicies.ci-deploy.resource[0]'],
    ]);
    expect(lockdownWarnings(PROJECT)[0]?.message).toMatch(/bypasses push's profile gate/);
  });
});

describe('resolveEnvironment', () => {
  const config: PlumbConfig = {
    igs: [],
    profiles: [],
    out: '/out',
    environments: {
      prod: {
        baseUrl: 'https://api.example.com/',
        clientId: { env: 'PROD_ID' },
        clientSecret: { env: 'PROD_SECRET' },
      },
      staging: {
        baseUrl: 'https://staging.example.com/',
        clientId: { env: 'STAGING_ID' },
        clientSecret: { env: 'STAGING_SECRET' },
        synthetic: true,
      },
    },
  };

  test('carries synthetic, so migrate --local knows where records may come to the CLI', () => {
    const staging = resolveEnvironment(config, 'staging', {
      STAGING_ID: 'id',
      STAGING_SECRET: 's',
    });
    expect(staging.ok && staging.environment.synthetic).toBe(true);
    const prod = resolveEnvironment(config, 'prod', { PROD_ID: 'id', PROD_SECRET: 's' });
    expect(prod.ok && prod.environment).not.toHaveProperty('synthetic');
  });

  test('reads the credentials from the variables the config names', () => {
    expect(resolveEnvironment(config, 'prod', { PROD_ID: 'id', PROD_SECRET: 'secret' })).toEqual({
      ok: true,
      environment: {
        name: 'prod',
        baseUrl: 'https://api.example.com/',
        clientId: 'id',
        clientSecret: 'secret',
      },
    });
  });

  test('unknown-environment, naming the ones the config has', () => {
    const result = resolveEnvironment(config, 'dev', {});
    expect(!result.ok && result.errors.map((e) => e.code)).toEqual(['unknown-environment']);
    expect(!result.ok && result.errors[0]?.message).toMatch(/prod, staging/);
    const inherited = resolveEnvironment(config, 'toString', {});
    expect(!inherited.ok && inherited.errors[0]?.code).toBe('unknown-environment');
    const none = resolveEnvironment({ ...config, environments: undefined }, 'prod', {});
    expect(!none.ok && none.errors[0]?.message).toMatch(/no environments/);
  });

  test('missing-variable, for each unset or empty one', () => {
    const result = resolveEnvironment(config, 'prod', { PROD_ID: '' });
    expect(!result.ok && result.errors.map((e) => [e.code, e.path])).toEqual([
      ['missing-variable', 'environments.prod.clientId'],
      ['missing-variable', 'environments.prod.clientSecret'],
    ]);
    expect(!result.ok && result.errors[1]?.message).toMatch(/PROD_SECRET/);
  });
});
