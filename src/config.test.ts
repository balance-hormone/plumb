// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  checkRoutes,
  defineConfig,
  environmentSettings,
  type LoadConfigResult,
  lockdownWarnings,
  type PlumbConfig,
  type ProjectConfig,
  resolveEnvironment,
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
      },
    },
  };

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
