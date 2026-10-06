// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { loadContent } from './content.js';
import { loadProfiles } from './loader.js';

const FIXTURES = join(import.meta.dirname, '../test/fixtures');
const ORGANIZATION = 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-organization';
// As generate and push do: loading registers base R4 with Medplum's validator.
const NO_PROFILES = loadProfiles({ packages: [], igs: [], profiles: [] });

// Synthetic content, one file each.
const QUESTIONNAIRE = {
  resourceType: 'Questionnaire',
  url: 'http://example.org/fhir/Questionnaire/intake',
  version: '1.0.0',
  status: 'active',
  item: [{ linkId: 'reason', text: 'Reason for visit', type: 'string' }],
};
const CODE_SYSTEM = {
  resourceType: 'CodeSystem',
  url: 'http://example.org/fhir/CodeSystem/visit-reason',
  status: 'active',
  content: 'complete',
  concept: [{ code: 'new' }, { code: 'follow-up' }],
};
const CLINIC = { resourceType: 'Organization', id: 'main-clinic', name: 'Main Clinic' };

function folder(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'plumb-content-'));
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return dir;
}

const codes = (result: ReturnType<typeof loadContent>) => result.errors.map((e) => e.code);

describe('loadContent', () => {
  test('reads each file a glob names, in order, keyed by URL or Organization id', () => {
    const dir = folder({
      'a-questionnaire.json': QUESTIONNAIRE,
      'b-codesystem.json': CODE_SYSTEM,
      'c-clinic.json': CLINIC,
    });
    const result = loadContent([join(dir, '*.json')], NO_PROFILES);
    expect(result.errors).toEqual([]);
    expect(result.files.map((f) => f.key)).toEqual([
      QUESTIONNAIRE.url,
      CODE_SYSTEM.url,
      'main-clinic',
    ]);
  });

  test('no content is no files and no errors', () => {
    expect(loadContent(undefined, NO_PROFILES)).toEqual({ ok: true, files: [], errors: [] });
  });

  test.each([
    ['not JSON', '{', /not JSON/],
    ['another type', { resourceType: 'Patient', id: 'p' }, /a Patient is not content/],
    [
      'a SearchParameter, which Medplum ignores',
      { resourceType: 'SearchParameter', url: 'http://example.org/sp' },
      /ignores a project's SearchParameters/,
    ],
    [
      'a Subscription',
      { resourceType: 'Subscription', status: 'active' },
      /declared with the bots they trigger/,
    ],
    ['a canonical without a url', { ...QUESTIONNAIRE, url: undefined }, /needs its canonical url/],
    ['an Organization without an id', { ...CLINIC, id: undefined }, /needs an id, its key/],
  ])('invalid-content: %s', (_, body, message) => {
    const dir = folder({ 'bad.json': body });
    const result = loadContent([join(dir, 'bad.json')], NO_PROFILES);
    expect(codes(result)).toEqual(['invalid-content']);
    expect(result.errors[0]?.message).toMatch(message);
  });

  test('invalid-content, for a path that matches no file', () => {
    const result = loadContent([join(tmpdir(), 'plumb-no-such-content', '*.json')], NO_PROFILES);
    expect(codes(result)).toEqual(['invalid-content']);
    expect(result.errors[0]?.message).toMatch(/matches no file/);
  });

  test('duplicate-content, for two files with one URL or one key', () => {
    const dir = folder({
      'a.json': QUESTIONNAIRE,
      'b.json': { ...QUESTIONNAIRE, version: '2.0.0' },
      'c.json': CLINIC,
      'd.json': { ...CLINIC, name: 'Main Clinic, again' },
    });
    const result = loadContent([join(dir, '*.json')], NO_PROFILES);
    expect(codes(result)).toEqual(['duplicate-content', 'duplicate-content']);
    expect(result.errors[0]?.message).toBe(
      `${join(dir, 'b.json')} and ${join(dir, 'a.json')} are both ${QUESTIONNAIRE.url}.`,
    );
  });

  // Medplum's validator checks structure, not terminology: a missing status, not a wrong one.
  test('content-refused, for what base R4 does not allow', () => {
    const dir = folder({ 'q.json': { ...QUESTIONNAIRE, status: undefined } });
    const result = loadContent([join(dir, 'q.json')], NO_PROFILES);
    expect(codes(result)).toEqual(['content-refused']);
    expect(result.errors[0]?.message).toMatch(/q\.json: .*status/);
  });

  test('content-refused, for a selected profile the file claims; one not selected is not checked', () => {
    const loaded = loadProfiles({
      packages: readdirSync(join(FIXTURES, 'packages')).map((folder) => {
        const [name, version] = folder.split('#') as [string, string];
        return { name, version, dir: join(FIXTURES, 'packages', folder) };
      }),
      igs: ['hl7.fhir.us.core@9.0.0'],
      profiles: [ORGANIZATION],
    });
    // US Core Organization requires `active`.
    const claims = { ...CLINIC, meta: { profile: [ORGANIZATION] } };
    const dir = folder({
      'claims.json': claims,
      'unselected.json': {
        ...CLINIC,
        id: 'other',
        meta: { profile: ['http://example.org/fhir/StructureDefinition/unselected'] },
      },
    });
    const refused = loadContent([join(dir, '*.json')], loaded);
    expect(codes(refused)).toEqual(['content-refused']);
    expect(refused.errors[0]?.message).toMatch(/claims\.json: .*active/);

    const fixed = folder({ 'claims.json': { ...claims, active: true } });
    expect(loadContent([join(fixed, 'claims.json')], loaded).errors).toEqual([]);
  });
});
