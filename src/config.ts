// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Coding, StructureDefinition } from '@medplum/fhirtypes';

export interface PlumbConfig {
  /** IG packages as `name@version`, with an exact version. */
  igs: string[];
  /**
   * Canonical URLs of the profiles to generate types for, or `name/*` for every
   * resource profile in an IG listed in `igs`.
   */
  profiles: string[];
  /** A folder of StructureDefinition JSON outside any package. */
  local?: string;
  /**
   * A SUSHI project: the folder holding `sushi-config.yaml`. Its output,
   * `fsh-generated/resources`, is the local folder, so `local` is not set too.
   */
  fsh?: string;
  /** The folder Plumb generates into and owns. */
  out: string;
  bindings?: {
    /** A value set with more codes is typed as its base type, not a union. 100 by default. */
    maxCodes?: number;
  };
  /** The Medplum projects `validate` and `push` act on, by name. */
  environments?: Record<string, Environment>;
  /**
   * Routing rows for selected profiles, by canonical URL, added to the keys
   * generated from each profile: for one keyed on a value set Plumb cannot
   * expand, or `false` to take a profile out of routing.
   */
  routes?: Record<string, RouteRow | false>;
  /**
   * The profiles stamped on every write of a type, as Medplum's
   * `Project.defaultProfile`: a stamp replaces the server's default, so
   * `createProfiled` stamps these too.
   */
  defaultProfile?: Record<string, string[]>;
}

/**
 * A first-level element, such as `code` or `category`, mapped to the values
 * that select the profile: codings, or strings for a `code` element. A
 * resource matches when the element holds any of them.
 */
export type RouteRow = Record<string, (Coding | string)[]>;

/**
 * A Medplum project, reached with client credentials. The config is committed,
 * so it names the environment variables that hold them, never the values.
 */
export interface Environment {
  baseUrl: string;
  clientId: { env: string };
  clientSecret: { env: string };
}

/** An environment with its credentials read from the environment variables. */
export interface ResolvedEnvironment {
  name: string;
  baseUrl: string;
  clientId: string;
  clientSecret: string;
}

export type ConfigErrorCode =
  | 'config-not-found'
  | 'unsupported-syntax'
  | 'unresolved-import'
  | 'no-default-export'
  | 'unknown-key'
  | 'missing-out'
  | 'invalid-type'
  | 'invalid-ig'
  | 'unlisted-ig'
  | 'invalid-profile'
  | 'invalid-max-codes'
  | 'invalid-base-url'
  | 'unknown-environment'
  | 'missing-variable'
  | 'invalid-route'
  | 'unselected-route'
  | 'invalid-route-element'
  | 'invalid-default-profile'
  | 'versioned-url'
  | 'fsh-and-local'
  | 'no-sushi-config';

export interface ConfigError {
  code: ConfigErrorCode;
  message: string;
  /** The config key the error is about. */
  path?: string;
}

export type LoadConfigResult =
  | { ok: true; configPath: string; config: PlumbConfig }
  | { ok: false; configPath: string; errors: ConfigError[] };

/** Types a config while editing; returns it unchanged. */
export function defineConfig(config: PlumbConfig): PlumbConfig {
  return config;
}

const DEFAULT_CONFIG = 'plumb.config.ts';
const KEYS = new Set([
  'igs',
  'profiles',
  'local',
  'fsh',
  'out',
  'bindings',
  'environments',
  'routes',
  'defaultProfile',
]);
const ENVIRONMENT_KEYS = ['baseUrl', 'clientId', 'clientSecret'] as const;
// FHIR package names are lowercase dotted segments; versions are exact, never ranges.
const NAME = '[a-z0-9][a-z0-9-]*(?:\\.[a-z0-9][a-z0-9-]*)+';
const IG = new RegExp(`^(${NAME})@\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?$`);
// The version lives in igs, so a wildcard names the package alone.
const ALL_PROFILES = new RegExp(`^(${NAME})/\\*$`);

/**
 * Loads `plumb.config.ts` from `cwd`, or `configPath` relative to it, with
 * Node's own type stripping. `local`, `fsh` and `out` come back as absolute
 * paths, resolved against the config file's folder; with `fsh`, `local` is its
 * SUSHI output.
 */
export async function loadConfig(options: {
  cwd: string;
  configPath?: string;
}): Promise<LoadConfigResult> {
  const configPath = resolve(options.cwd, options.configPath ?? DEFAULT_CONFIG);
  const fail = (...errors: ConfigError[]): LoadConfigResult => ({ ok: false, configPath, errors });
  if (!existsSync(configPath)) {
    return fail({ code: 'config-not-found', message: `No config file at ${configPath}.` });
  }

  let module: { default?: unknown };
  try {
    module = await import(pathToFileURL(configPath).href);
  } catch (err) {
    const error = importError(err);
    if (error) return fail(error);
    throw err;
  }
  if (module.default === undefined) {
    return fail({
      code: 'no-default-export',
      message: 'The config file must `export default defineConfig({ … })`.',
    });
  }

  const errors = check(module.default);
  if (errors.length > 0) return fail(...errors);
  const config = module.default as PlumbConfig;
  const base = dirname(configPath);
  const fsh = config.fsh === undefined ? undefined : resolve(base, config.fsh);
  if (fsh && !existsSync(join(fsh, 'sushi-config.yaml'))) {
    return fail({
      code: 'no-sushi-config',
      path: 'fsh',
      message: `"fsh" names ${fsh}, which has no sushi-config.yaml. It must be the folder of a SUSHI project.`,
    });
  }
  const local = fsh
    ? join(fsh, 'fsh-generated', 'resources')
    : config.local && resolve(base, config.local);
  return {
    ok: true,
    configPath,
    config: {
      ...config,
      out: resolve(base, config.out),
      ...(fsh ? { fsh } : {}),
      ...(local ? { local } : {}),
    },
  };
}

// Node resolves imports itself and only strips types, so these are the limits
// a config file meets that a bundler-loaded one would not.
function importError(err: unknown): ConfigError | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  const message = (err instanceof Error ? err.message : String(err)).replace(/\n[\s\S]*/, '');
  if (code === 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX') {
    return {
      code: 'unsupported-syntax',
      message: `${message}. Node loads the config by stripping types, so TypeScript-only syntax such as enum or namespace cannot be used.`,
    };
  }
  if (code === 'ERR_MODULE_NOT_FOUND') {
    const hint = message.startsWith('Cannot find package')
      ? 'Node does not read tsconfig paths, so a path alias cannot be used; import the file by its relative path, or install the package.'
      : 'Node resolves imports as written, so a relative import needs its .ts extension.';
    return { code: 'unresolved-import', message: `${message}. ${hint}` };
  }
  return undefined;
}

function check(config: unknown): ConfigError[] {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    return [{ code: 'invalid-type', message: 'The default export must be an object.' }];
  }
  const errors: ConfigError[] = [];
  const record = config as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!KEYS.has(key)) {
      errors.push({ code: 'unknown-key', path: key, message: `Unknown config key "${key}".` });
    }
  }
  errors.push(
    ...checkList(record, 'igs', (ig) => IG.test(ig), 'invalid-ig', 'name@version, exact version'),
    // A profile is named by its canonical URL alone; the version comes from its package.
    ...checkList(
      record,
      'profiles',
      (p) => ALL_PROFILES.test(p) || (URL.canParse(p) && !p.includes('|')),
      'invalid-profile',
      'an absolute canonical URL without a |version, or name/* for a whole IG',
    ),
    ...checkWildcards(record),
  );
  errors.push(
    ...checkBindings(record.bindings),
    ...checkEnvironments(record.environments),
    ...checkRouteRows(record),
    ...checkDefaultProfile(record.defaultProfile),
  );
  for (const key of ['local', 'fsh']) {
    if (record[key] !== undefined && typeof record[key] !== 'string') {
      errors.push({ code: 'invalid-type', path: key, message: `"${key}" must be a path.` });
    }
  }
  if (record.local !== undefined && record.fsh !== undefined) {
    errors.push({
      code: 'fsh-and-local',
      path: 'fsh',
      message:
        '"fsh" and "local" are both set. With "fsh", SUSHI\'s output is the local folder: remove "local".',
    });
  }
  if (record.out === undefined) {
    errors.push({ code: 'missing-out', path: 'out', message: '"out" is required.' });
  } else if (typeof record.out !== 'string') {
    errors.push({ code: 'invalid-type', path: 'out', message: '"out" must be a path.' });
  }
  return errors;
}

function checkList(
  record: Record<string, unknown>,
  key: 'igs' | 'profiles',
  valid: (item: string) => boolean,
  code: ConfigErrorCode,
  expected: string,
): ConfigError[] {
  const list = record[key];
  if (!Array.isArray(list) || list.some((item) => typeof item !== 'string')) {
    return [{ code: 'invalid-type', path: key, message: `"${key}" must be a list of strings.` }];
  }
  return (list as string[]).flatMap((item, i) =>
    valid(item) ? [] : [{ code, path: `${key}[${i}]`, message: `"${item}" is not ${expected}.` }],
  );
}

function checkWildcards(record: Record<string, unknown>): ConfigError[] {
  const { igs, profiles } = record;
  if (!Array.isArray(igs) || !Array.isArray(profiles)) return [];
  const listed = new Set(igs.map((ig) => IG.exec(String(ig))?.[1]));
  return profiles.flatMap((profile, i) => {
    const name = ALL_PROFILES.exec(String(profile))?.[1];
    return name && !listed.has(name)
      ? [
          {
            code: 'unlisted-ig' as const,
            path: `profiles[${i}]`,
            message: `"${profile}" names ${name}, which igs does not list.`,
          },
        ]
      : [];
  });
}

function checkBindings(bindings: unknown): ConfigError[] {
  if (bindings === undefined) return [];
  if (typeof bindings !== 'object' || bindings === null || Array.isArray(bindings)) {
    return [{ code: 'invalid-type', path: 'bindings', message: '"bindings" must be an object.' }];
  }
  const errors: ConfigError[] = Object.keys(bindings)
    .filter((key) => key !== 'maxCodes')
    .map((key) => ({
      code: 'unknown-key' as const,
      path: `bindings.${key}`,
      message: `Unknown config key "bindings.${key}".`,
    }));
  const { maxCodes } = bindings as { maxCodes?: unknown };
  if (maxCodes !== undefined && !(Number.isInteger(maxCodes) && (maxCodes as number) >= 1)) {
    errors.push({
      code: 'invalid-max-codes',
      path: 'bindings.maxCodes',
      message: '"bindings.maxCodes" must be a whole number of at least 1.',
    });
  }
  return errors;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function checkEnvironments(environments: unknown): ConfigError[] {
  if (environments === undefined) return [];
  if (!isObject(environments)) {
    return [
      { code: 'invalid-type', path: 'environments', message: '"environments" must be an object.' },
    ];
  }
  return Object.entries(environments).flatMap(([name, environment]): ConfigError[] => {
    const at = `environments.${name}`;
    if (!isObject(environment)) {
      return [{ code: 'invalid-type', path: at, message: `"${at}" must be an object.` }];
    }
    const errors: ConfigError[] = Object.keys(environment)
      .filter((key) => !(ENVIRONMENT_KEYS as readonly string[]).includes(key))
      .map((key) => ({
        code: 'unknown-key',
        path: `${at}.${key}`,
        message: `Unknown config key "${at}.${key}".`,
      }));
    const { baseUrl } = environment;
    if (typeof baseUrl !== 'string' || !/^https?:$/.test(URL.parse(baseUrl)?.protocol ?? '')) {
      errors.push({
        code: 'invalid-base-url',
        path: `${at}.baseUrl`,
        message: `"${at}.baseUrl" must be the server's http or https URL.`,
      });
    }
    for (const key of ['clientId', 'clientSecret'] as const) {
      const value = environment[key];
      if (!isObject(value) || typeof value.env !== 'string' || value.env === '') {
        errors.push({
          code: 'invalid-type',
          path: `${at}.${key}`,
          message: `"${at}.${key}" must be { env: 'VAR' }, the name of the environment variable that holds it: the config is committed, so it never holds the value.`,
        });
      }
    }
    return errors;
  });
}

/** A canonical URL as Medplum matches it: absolute, and bare, since a `url|version` stamp validates nothing. */
function checkUrl(url: string, path: string): ConfigError[] {
  if (url.includes('|')) {
    return [
      {
        code: 'versioned-url',
        path,
        message: `"${url}" has a |version: Medplum matches bare URLs only, so a versioned stamp validates nothing.`,
      },
    ];
  }
  return URL.canParse(url)
    ? []
    : [{ code: 'invalid-type', path, message: `"${url}" is not an absolute canonical URL.` }];
}

const isCoding = (value: unknown) =>
  isObject(value) &&
  typeof value.code === 'string' &&
  (value.system === undefined || typeof value.system === 'string');

/** The shape of each routing row; whether its profile and elements exist is checked once profiles load. */
function checkRouteRows(record: Record<string, unknown>): ConfigError[] {
  const { routes, profiles } = record;
  if (routes === undefined) return [];
  if (!isObject(routes)) {
    return [{ code: 'invalid-type', path: 'routes', message: '"routes" must be an object.' }];
  }
  // With name/* the selection is known only once the IGs load.
  const listed = Array.isArray(profiles) ? profiles.map(String) : [];
  const complete = !listed.some((p) => ALL_PROFILES.test(p));
  return Object.entries(routes).flatMap(([url, row]): ConfigError[] => {
    const at = `routes["${url}"]`;
    const errors = checkUrl(url, at);
    if (errors.length === 0 && complete && !listed.includes(url)) errors.push(unselected(url, at));
    if (row === false) return errors;
    if (!isObject(row) || Object.keys(row).length === 0) {
      return [...errors, invalidRoute(at, 'must map elements to their values, or be false')];
    }
    for (const [element, values] of Object.entries(row)) {
      const valid =
        Array.isArray(values) &&
        values.length > 0 &&
        values.every((v) => typeof v === 'string' || isCoding(v));
      if (!valid) {
        errors.push(invalidRoute(`${at}.${element}`, 'must be a list of codings or code strings'));
      }
    }
    return errors;
  });
}

const invalidRoute = (path: string, what: string): ConfigError => ({
  code: 'invalid-route',
  path,
  message: `"${path}" ${what}.`,
});

const unselected = (url: string, path: string): ConfigError => ({
  code: 'unselected-route',
  path,
  message: `"${url}" has a routing row but is not a selected profile; add it to profiles.`,
});

function checkDefaultProfile(defaults: unknown): ConfigError[] {
  if (defaults === undefined) return [];
  const malformed = (path: string, what: string): ConfigError => ({
    code: 'invalid-default-profile',
    path,
    message: `"${path}" ${what}.`,
  });
  if (!isObject(defaults)) {
    return [malformed('defaultProfile', 'must map resource types to profile URLs')];
  }
  return Object.entries(defaults).flatMap(([type, urls]): ConfigError[] => {
    const at = `defaultProfile.${type}`;
    if (!/^[A-Z][A-Za-z]+$/.test(type)) return [malformed(at, 'is not a resource type')];
    if (!Array.isArray(urls) || urls.length === 0 || urls.some((u) => typeof u !== 'string')) {
      return [malformed(at, 'must be a list of profile URLs')];
    }
    return (urls as string[]).flatMap((url, i) => checkUrl(url, `${at}[${i}]`));
  });
}

/**
 * The routing rows against the loaded profiles: each names a selected
 * profile, and each element is a first-level element of the profile's type.
 */
export function checkRoutes(
  config: Pick<PlumbConfig, 'routes'>,
  selected: { url: string; sd: StructureDefinition }[],
): ConfigError[] {
  return Object.entries(config.routes ?? {}).flatMap(([url, row]): ConfigError[] => {
    const at = `routes["${url}"]`;
    const profile = selected.find((p) => p.url === url);
    if (!profile) return [unselected(url, at)];
    if (row === false) return [];
    const type = profile.sd.type;
    const elements = (profile.sd.snapshot?.element ?? []).map((e) => e.path.split('.'));
    const firstLevel = elements.filter((p) => p.length === 2).map((p) => p[1] as string);
    return Object.keys(row)
      .filter((element) => !isFirstLevel(element, firstLevel))
      .map((element) => ({
        code: 'invalid-route-element' as const,
        path: `${at}.${element}`,
        message: `"${element}" is not a first-level element of ${type}.`,
      }));
  });
}

/** `code`, or a choice's typed name such as `valueCodeableConcept` for `value[x]`. */
const isFirstLevel = (element: string, firstLevel: string[]) =>
  firstLevel.some((name) =>
    name.endsWith('[x]')
      ? element.startsWith(name.slice(0, -3)) && /^[A-Z]/.test(element.slice(name.length - 3))
      : name === element,
  );

/** Picks an environment by name and reads its credentials from `env`. */
export function resolveEnvironment(
  config: PlumbConfig,
  name: string,
  env: Record<string, string | undefined>,
): { ok: true; environment: ResolvedEnvironment } | { ok: false; errors: ConfigError[] } {
  const environments = config.environments ?? {};
  // Own keys only, so a name such as "toString" is unknown rather than inherited.
  const environment = Object.hasOwn(environments, name) ? environments[name] : undefined;
  if (!environment) {
    const known = Object.keys(environments);
    return {
      ok: false,
      errors: [
        {
          code: 'unknown-environment',
          path: 'environments',
          message: known.length
            ? `No environment "${name}": the config has ${known.join(', ')}.`
            : `No environment "${name}": the config has no environments.`,
        },
      ],
    };
  }
  const keys = ['clientId', 'clientSecret'] as const;
  const errors = keys
    .filter((key) => !env[environment[key].env])
    .map((key) => ({
      code: 'missing-variable' as const,
      path: `environments.${name}.${key}`,
      message: `${environment[key].env} is not set: it holds ${key} for the "${name}" environment.`,
    }));
  if (errors.length > 0) return { ok: false, errors };
  // Both are set: the filter above found neither missing.
  return {
    ok: true,
    environment: {
      name,
      baseUrl: environment.baseUrl,
      clientId: env[environment.clientId.env] as string,
      clientSecret: env[environment.clientSecret.env] as string,
    },
  };
}
