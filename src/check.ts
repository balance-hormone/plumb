// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, matchesGlob, relative, sep } from 'node:path';
import type * as TS from 'typescript5';
import type { PlumbConfig } from './config.js';
import { type Route, routingRows } from './emit/routes.js';
import { loadProfiles } from './loader.js';
import { lockedPackages } from './packages.js';

/** A `MedplumClient` read or write of a profiled type that goes around Plumb. */
export interface Finding {
  /** Relative to the config's folder, with forward slashes. */
  file: string;
  line: number;
  column: number;
  method: string;
  /** The profiled resource types the call can touch, sorted. */
  resourceTypes: string[];
  /** What to call instead, or why the finding stands. */
  instead: string;
}

const READS = ['readResource', 'searchResources', 'searchOne', 'searchResourcePages'];
const WRITES = ['createResource', 'updateResource', 'upsertResource', 'createResourceIfNoneExist'];
const INSTEAD: Record<string, string> = {
  readResource: 'readProfiled',
  searchResources: 'searchProfiled',
  searchOne: 'searchProfiled',
  searchResourcePages: 'searchProfiled',
};
const WRITE_INSTEAD = 'createProfiled, updateProfiled or stampProfiled';
// A union this wide is `ResourceType` itself: it says nothing about which.
const UNKNOWN_WIDTH = 50;
const SUPPRESS = /^\s*\/\/\s*plumb-check:(.*)$/;
// The property the generated `Stamped` brand declares.
const BRAND = /^__@plumbStamped@/;

export interface FindOptions {
  /** The project's TypeScript module, with its compiler API. */
  ts: typeof TS;
  /** The folder findings are relative to, and `ignore` is matched from. */
  base: string;
  tsconfig: string[];
  /** Resource types a selected profile constrains. */
  profiledTypes: ReadonlySet<string>;
  /** The generated folder, never checked. */
  out: string;
  ignore?: string[];
}

/**
 * Compiles each project and reports every raw `MedplumClient` read or write of
 * a profiled type, with the type the checker infers, not the text written.
 */
export function findRawAccess(options: FindOptions): { findings: Finding[]; files: number } {
  const { ts } = options;
  const seen = new Set<string>();
  const findings: Finding[] = [];
  for (const tsconfig of options.tsconfig) {
    const program = createProgram(ts, tsconfig);
    const checker = program.getTypeChecker();
    for (const source of program.getSourceFiles()) {
      const file = relative(options.base, source.fileName).split(sep).join('/');
      if (seen.has(source.fileName) || !checked(source, file, options)) continue;
      seen.add(source.fileName);
      findings.push(...inFile(ts, checker, source, file, options.profiledTypes));
    }
  }
  return { findings, files: seen.size };
}

function createProgram(ts: typeof TS, tsconfig: string): TS.Program {
  const parsed = ts.getParsedCommandLineOfConfigFile(
    tsconfig,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (d) => {
        throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n'));
      },
    },
  );
  if (!parsed) throw new Error(`Could not read ${tsconfig}.`);
  return ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
}

function checked(source: TS.SourceFile, file: string, options: FindOptions): boolean {
  if (source.isDeclarationFile || file.startsWith('..') || file.includes('node_modules/')) {
    return false;
  }
  if (!relative(options.out, source.fileName).startsWith('..')) return false;
  return !(options.ignore ?? []).some((glob) => matchesGlob(file, glob));
}

function inFile(
  ts: typeof TS,
  checker: TS.TypeChecker,
  source: TS.SourceFile,
  file: string,
  profiled: ReadonlySet<string>,
): Finding[] {
  const lines = source.text.split('\n');
  const found: Finding[] = [];
  const visit = (node: TS.Node): void => {
    const finding = ts.isCallExpression(node) && rawCall(ts, checker, node, profiled);
    if (finding) {
      const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
      const reason = SUPPRESS.exec(lines[line - 1] ?? '')?.[1]?.trim();
      if (reason === undefined || reason === '') {
        found.push({
          file,
          line: line + 1,
          column: character + 1,
          ...finding,
          ...(reason === '' ? { instead: 'a plumb-check comment needs a reason' } : {}),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** The finding a call makes, if it is a raw read or write of a profiled type. */
function rawCall(
  ts: typeof TS,
  checker: TS.TypeChecker,
  call: TS.CallExpression,
  profiled: ReadonlySet<string>,
): Pick<Finding, 'method' | 'resourceTypes' | 'instead'> | undefined {
  if (!ts.isPropertyAccessExpression(call.expression)) return undefined;
  const method = call.expression.name.text;
  const isRead = READS.includes(method);
  if (!isRead && !WRITES.includes(method)) return undefined;
  if (!isMedplumClient(checker, checker.getTypeAtLocation(call.expression.expression))) {
    return undefined;
  }
  const arg = call.arguments[0];
  if (!arg) return undefined;
  const type = checker.getTypeAtLocation(arg);
  if (!isRead && isStamped(checker, type)) return undefined;
  const names = isRead ? literals(type) : resourceTypes(checker, type, arg);
  const resourceTypesFound = [...new Set(names.filter((n) => profiled.has(n)))].sort();
  if (resourceTypesFound.length === 0) return undefined;
  return {
    method,
    resourceTypes: resourceTypesFound,
    instead: INSTEAD[method] ?? WRITE_INSTEAD,
  };
}

/** `MedplumClient` from `@medplum/core`, or a class deriving from it (`MockClient`). */
function isMedplumClient(checker: TS.TypeChecker, type: TS.Type): boolean {
  const candidates = type.isUnion() ? type.types : [type.getNonNullableType()];
  return candidates.some((t) => {
    const symbol = t.getSymbol();
    const declaredInCore = symbol?.declarations?.some((d) =>
      d.getSourceFile().fileName.includes('@medplum/core'),
    );
    if (symbol?.getName() === 'MedplumClient' && declaredInCore) return true;
    if (!t.isClassOrInterface()) return false;
    return checker.getBaseTypes(t).some((base) => isMedplumClient(checker, base));
  });
}

function literals(type: TS.Type): string[] {
  const parts = type.isUnion() ? type.types : [type];
  if (parts.length > UNKNOWN_WIDTH) return [];
  return parts.flatMap((t) => (t.isStringLiteral() ? [t.value] : []));
}

/** The `resourceType` values a write's argument can have. */
function resourceTypes(checker: TS.TypeChecker, type: TS.Type, at: TS.Node): string[] {
  const parts = type.isUnion() ? type.types : [type];
  return parts.flatMap((t) => {
    const property = checker.getPropertyOfType(t, 'resourceType');
    return property ? literals(checker.getTypeOfSymbolAtLocation(property, at)) : [];
  });
}

function isStamped(checker: TS.TypeChecker, type: TS.Type): boolean {
  return checker.getPropertiesOfType(type).some((p) => BRAND.test(String(p.escapedName)));
}

/** Accepted findings, counted per file, method and resource types. */
export type Baseline = Record<string, number>;

const key = (f: Finding) => `${f.file}|${f.method}|${f.resourceTypes.join(',')}`;

export function countFindings(findings: Finding[]): Baseline {
  const counts: Baseline = {};
  for (const f of findings) counts[key(f)] = (counts[key(f)] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

export interface BaselineComparison {
  /** Findings under a key that is new or grew: every one of them, since a line cannot be told apart. */
  fresh: Finding[];
  /** How many findings the baseline accepts that are now gone. */
  fixed: number;
  /** Findings the baseline accepts. */
  accepted: number;
}

/** A finding fails only where its key's count exceeds the baseline's. */
export function compareBaseline(findings: Finding[], baseline: Baseline): BaselineComparison {
  const counts = countFindings(findings);
  const grown = new Set(Object.keys(counts).filter((k) => (counts[k] ?? 0) > (baseline[k] ?? 0)));
  const fixed = Object.entries(baseline).reduce(
    (sum, [k, n]) => sum + Math.max(0, n - (counts[k] ?? 0)),
    0,
  );
  const fresh = findings.filter((f) => grown.has(key(f)));
  return { fresh, fixed, accepted: findings.length - fresh.length };
}

export interface CheckResult {
  ok: boolean;
  findings: Finding[];
  comparison: BaselineComparison;
  files: number;
  /** Set when `updateBaseline` wrote the file. */
  baselineWritten?: boolean;
  errors: {
    code: 'no-check-config' | 'no-compiler-api' | 'no-lock' | 'load-failed' | 'baseline-growth';
    message: string;
  }[];
}

export interface CheckOptions {
  config: PlumbConfig;
  configPath: string;
  /** The project's TypeScript; resolved from the config's folder by default. */
  ts?: typeof TS;
  cacheDir?: string;
  updateBaseline?: boolean;
  allowGrowth?: boolean;
}

/**
 * `plumb check`: loads the selected profiles for the types they constrain,
 * compiles the configured projects, and compares what it finds with the
 * baseline, or rewrites the baseline.
 */
export async function checkProject(options: CheckOptions): Promise<CheckResult> {
  const fail = (code: CheckResult['errors'][number]['code'], message: string): CheckResult => ({
    ok: false,
    findings: [],
    comparison: { fresh: [], fixed: 0, accepted: 0 },
    files: 0,
    errors: [{ code, message }],
  });
  const { config, configPath } = options;
  const check = config.check;
  if (!check) return fail('no-check-config', 'plumb.config.ts has no "check".');
  const base = dirname(configPath);
  const tsconfig = [check.tsconfig].flat();
  const ts = options.ts ?? projectTypeScript(base);
  if (!ts) {
    return fail(
      'no-compiler-api',
      "The project's typescript has no compiler API (TypeScript 7's native package does not). plumb check needs TypeScript 5 or 6.",
    );
  }
  let packages: ReturnType<typeof lockedPackages>;
  try {
    packages = lockedPackages(join(base, 'plumb.lock'), options.cacheDir);
  } catch (err) {
    return fail('no-lock', err instanceof Error ? err.message : String(err));
  }
  const loaded = loadProfiles({
    packages,
    igs: config.igs,
    local: config.local,
    profiles: config.profiles,
  });
  // Without the profiles, nothing would be found and an updated baseline would be emptied.
  if (!loaded.ok) {
    return {
      ...fail('load-failed', ''),
      errors: loaded.errors.map((e) => ({ code: 'load-failed', message: e.message })),
    };
  }
  const profiledTypes = enforcedTypes(routingRows(loaded, config).routes, config.defaultProfile);
  const { findings, files } = findRawAccess({
    ts,
    base: checkRoot(configPath, tsconfig),
    tsconfig,
    profiledTypes,
    out: config.out,
    ignore: check.ignore,
  });
  const baseline = readBaseline(check.baseline);
  const comparison = compareBaseline(findings, baseline);
  if (options.updateBaseline && check.baseline) {
    if (comparison.fresh.length > 0 && !options.allowGrowth) {
      return {
        ...fail(
          'baseline-growth',
          'The baseline would grow. Fix the new findings, or pass --allow-growth.',
        ),
        findings,
        comparison,
        files,
      };
    }
    writeFileSync(check.baseline, `${JSON.stringify(countFindings(findings), null, 2)}\n`);
    return { ok: true, findings, comparison, files, baselineWritten: true, errors: [] };
  }
  return { ok: comparison.fresh.length === 0, findings, comparison, files, errors: [] };
}

function readBaseline(path: string | undefined): Baseline {
  return path && existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Baseline) : {};
}

function projectTypeScript(base: string): typeof TS | undefined {
  try {
    const ts = createRequire(join(base, 'package.json'))('typescript') as typeof TS;
    return typeof ts.createProgram === 'function' ? ts : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The folder findings and `ignore` globs are relative to: the deepest one
 * holding the config and every tsconfig, so a monorepo's config in one package
 * checks code in another, and baseline keys do not depend on where it runs.
 */
export function checkRoot(configPath: string, tsconfig: string[]): string {
  const parts = [configPath, ...tsconfig].map((path) => dirname(path).split(sep));
  const shared: string[] = [];
  for (const [i, segment] of (parts[0] ?? []).entries()) {
    if (!parts.every((p) => p[i] === segment)) break;
    shared.push(segment);
  }
  return shared.join(sep) || sep;
}

/**
 * The types every resource of which a selected profile holds: one with a
 * profile that routes on no keys, or a `defaultProfile`. A profile keyed on
 * content (one code of Observation) holds only some, so raw access to the type
 * is not wrong and is not reported.
 */
export function enforcedTypes(
  routes: Record<string, Route[]>,
  defaultProfile: Record<string, string[]> = {},
): Set<string> {
  const unkeyed = Object.entries(routes)
    .filter(([, rows]) => rows.some((row) => row.keys.length === 0))
    .map(([type]) => type);
  return new Set([...unkeyed, ...Object.keys(defaultProfile)]);
}
