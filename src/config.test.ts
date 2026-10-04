// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  checkRoutes,
  type LoadConfigResult,
  type PlumbConfig,
  resolveEnvironment,
} from './config.js';
import { loadProfiles } from './loader.js';

const CONFIG_MODULE = join(import.meta.dirname, 'config.ts');

// Vitest transforms TypeScript itself, so loading runs in a plain Node process
// to exercise Node's own type stripping, as the CLI will.
function load(files: Record<string, string>, configPath?: string): LoadConfigResult {
  const cwd = mkdtempSync(join(tmpdir(), 'plumb-config-'));
  writeFileSync(join(cwd, 'package.json'), '{ "type": "module" }');
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
