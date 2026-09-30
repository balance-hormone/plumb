// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { LoadConfigResult } from './config.js';

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
});
