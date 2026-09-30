// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Resource } from '@medplum/fhirtypes';

const ROOT = join(import.meta.dirname, '../..');
// Inside node_modules so the check file resolves @medplum/fhirtypes from the project.
const OUT = join(ROOT, 'node_modules/.cache/plumb-harness');

/** Where a profile's generated type is imported from. */
export interface ProfileType {
  module: string;
  typeName: string;
}

/** Filled from `generate`'s report once the generator lands (#14). Keyed by profile URL. */
export const profileTypes = new Map<string, ProfileType>();

/** Profiles whose compile rows fail until the generator handles them. The list only shrinks. */
export const expectedFailures = new Set<string>(
  JSON.parse(readFileSync(join(import.meta.dirname, 'expected-failures.json'), 'utf8')) as string[],
);

export interface CompileCase {
  type: ProfileType;
  /** Written as a literal annotated with `type`. */
  resource?: Resource;
  /** Written as `const x: type = null as unknown as source`, for assignability. */
  source?: ProfileType;
  compiles: boolean;
}

/** The base type from `@medplum/fhirtypes` for a resource. */
export function baseType(resource: Resource): ProfileType {
  return { module: '@medplum/fhirtypes', typeName: resource.resourceType };
}

/**
 * Type-checks every case in one `tsc` run and returns each case's diagnostics.
 * A case with `compiles: false` carries `@ts-expect-error`, so every case passes
 * with no diagnostics, and an unused expectation is itself a diagnostic.
 */
export function compileCases(name: string, cases: CompileCase[]): string[][] {
  const imports = new Map<string, string>();
  const alias = (t: ProfileType): string => {
    const key = `${t.module}#${t.typeName}`;
    if (!imports.has(key)) imports.set(key, `T${imports.size}`);
    return imports.get(key) as string;
  };
  const body: string[] = [];
  const lineToCase = new Map<number, number>();
  cases.forEach((c, i) => {
    const value = c.source
      ? `null as unknown as ${alias(c.source)}`
      : // One line, so @ts-expect-error covers an error anywhere in the literal.
        JSON.stringify(c.resource);
    const lines = [
      ...(c.compiles ? [] : ['// @ts-expect-error']),
      `export const c${i}: ${alias(c.type)} = ${value};`,
    ];
    for (const line of lines) {
      body.push(line);
      lineToCase.set(body.length, i);
    }
  });
  const header = [...imports].map(([key, a]) => {
    const [module, typeName] = key.split('#');
    return `import type { ${typeName} as ${a} } from '${module}';`;
  });
  header.push('export {};');

  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, `${name}.ts`), [...header, ...body].join('\n'));
  writeFileSync(
    join(OUT, `${name}.tsconfig.json`),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2024',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        types: [],
      },
      files: [`${name}.ts`],
    }),
  );
  const result = spawnSync(
    join(ROOT, 'node_modules/.bin/tsc'),
    ['-p', `${name}.tsconfig.json`, '--pretty', 'false'],
    { cwd: OUT, encoding: 'utf8' },
  );

  const diagnostics: string[][] = cases.map(() => []);
  for (const line of result.stdout.split('\n').filter(Boolean)) {
    const at = new RegExp(`^${name}\\.ts\\((\\d+),\\d+\\): (.*)$`).exec(line);
    const i = at ? lineToCase.get(Number(at[1]) - header.length) : undefined;
    // A diagnostic outside any case (an import, the config) would hide every result.
    if (i === undefined) throw new Error(`tsc: ${line}${result.stderr}`);
    diagnostics[i]?.push(at?.[2] ?? line);
  }
  if (result.status !== 0 && !result.stdout) throw new Error(`tsc failed: ${result.stderr}`);
  return diagnostics;
}
