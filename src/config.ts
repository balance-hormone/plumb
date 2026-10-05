// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  AccessPolicy,
  AccessPolicyResource,
  Coding,
  StructureDefinition,
} from '@medplum/fhirtypes';
import type * as Tsx from 'tsx/esm/api';

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
  /** What `push` writes to each environment's project besides its profiles. */
  project?: ProjectConfig;
  /** What `plumb check` reads. */
  check?: CheckConfig;
}

/** What `plumb check` reads: the project's code, for raw access to profiled types. */
export interface CheckConfig {
  /** The TypeScript projects to check, each compiled once; a path or several. */
  tsconfig: string | string[];
  /** The committed file of accepted findings; without one, every finding fails. */
  baseline?: string;
  /** Globs, relative to the config, of files not to check (tests, stories). */
  ignore?: string[];
}

/** A check config as `loadConfig` returns it, with absolute paths. */
interface ResolvedCheckConfig {
  tsconfig: string[];
  baseline?: string;
  ignore: string[];
}

/**
 * A project's configuration, as a project admin can write it. Policies and
 * clients are named by a key, never an id, since ids differ per environment.
 */
export interface ProjectConfig {
  /** `Project.setting`; a value's type picks the setting's type. */
  settings?: Settings;
  /**
   * `Project.secret` by name: `{ env }` names the variable holding its value,
   * since the config is committed; `true` means it is set by hand and must exist.
   */
  secrets?: Record<string, { env: string } | true>;
  /** AccessPolicies by key; `name` is the key unless given. */
  accessPolicies?: Record<string, AccessPolicyConfig>;
  /** `Project.defaultAccessPolicies`, naming each policy by its key. */
  defaultAccessPolicies?: {
    profileType: (typeof PROFILE_TYPES)[number];
    accessPolicy: string;
  }[];
  /** Client applications by key, with their membership's policy key and `admin`. */
  clients?: Record<string, { accessPolicy?: string; admin?: boolean }>;
}

export type Settings = Record<string, string | boolean | number>;

export type AccessPolicyConfig = Omit<AccessPolicy, 'resourceType' | 'id' | 'meta'>;

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
  /** Settings for this environment, merged over `project.settings`. */
  settings?: Settings;
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
  | 'no-sushi-config'
  | 'invalid-setting'
  | 'super-admin-field'
  | 'unknown-access-policy'
  | 'duplicate-key'
  | 'invalid-check';

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
  'project',
  'check',
]);
const ENVIRONMENT_KEYS = ['baseUrl', 'clientId', 'clientSecret', 'settings'] as const;
const PROJECT_KEYS = ['settings', 'secrets', 'accessPolicies', 'defaultAccessPolicies', 'clients'];
// A project admin's write to these is silently restored, so declaring one would never take.
const SUPER_ADMIN_FIELDS = ['strictMode', 'features', 'link', 'systemSetting'];
// Medplum's member roles; @medplum/fhirtypes 5.1 has no type for them yet.
const PROFILE_TYPES = ['Patient', 'Practitioner', 'RelatedPerson', 'Admin'] as const;
// FHIR package names are lowercase dotted segments; versions are exact, never ranges.
const NAME = '[a-z0-9][a-z0-9-]*(?:\\.[a-z0-9][a-z0-9-]*)+';
const IG = new RegExp(`^(${NAME})@\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?$`);
// The version lives in igs, so a wildcard names the package alone.
const ALL_PROFILES = new RegExp(`^(${NAME})/\\*$`);

/**
 * Loads `plumb.config.ts` from `cwd`, or `configPath` relative to it, with
 * Node's type stripping, or the project's own tsx for what Node cannot load.
 * `local`, `fsh` and `out` come back as absolute
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

  const url = pathToFileURL(configPath).href;
  let module: { default?: unknown };
  try {
    module = await import(url);
  } catch (err) {
    const error = importError(err, false);
    if (!error) throw err;
    // Only for what Node cannot load: tsx's esbuild breaks in some
    // environments that load the config, such as a jsdom test.
    const tsx = findTsx(configPath);
    if (!tsx) return fail(error);
    try {
      const tsconfig = nearest(configPath, 'tsconfig.json');
      module = await tsx.tsImport(url, { parentURL: url, ...(tsconfig ? { tsconfig } : {}) });
    } catch (err) {
      const error = importError(err, true);
      if (error) return fail(error);
      throw err;
    }
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
      ...(config.check ? { check: resolveCheck(base, config.check) } : {}),
      ...(fsh ? { fsh } : {}),
      ...(local ? { local } : {}),
    },
  };
}

// tsx is the project's, never Plumb's dependency: a workspace that imports
// TypeScript source or uses path aliases already runs its scripts through it.
function findTsx(configPath: string): typeof Tsx | undefined {
  const projectRequire = createRequire(configPath);
  try {
    projectRequire.resolve('tsx/esm/api');
  } catch {
    return undefined;
  }
  return projectRequire('tsx/esm/api') as typeof Tsx;
}

// tsx reads the tsconfig in the working directory unless told, and the config
// may sit elsewhere.
function nearest(from: string, name: string): string | undefined {
  for (let dir = dirname(from); ; dir = dirname(dir)) {
    if (existsSync(join(dir, name))) return join(dir, name);
    if (dir === dirname(dir)) return undefined;
  }
}

// Node resolves imports itself and only strips types, so these are the limits
// a config file meets that a bundler-loaded one would not. tsx lifts them all.
function importError(err: unknown, tsx: boolean): ConfigError | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  const message = (err instanceof Error ? err.message : String(err)).replace(/\n[\s\S]*/, '');
  const install = 'Or install tsx in the project, and Plumb loads the config with it.';
  if (code === 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX') {
    return {
      code: 'unsupported-syntax',
      message: `${message}. Node loads the config by stripping types, so TypeScript-only syntax such as enum or namespace cannot be used. ${install}`,
    };
  }
  if (code === 'ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING') {
    return {
      code: 'unsupported-syntax',
      message: `${message}. Node does not strip types in files under node_modules, so the config cannot import a package that exports TypeScript source; install tsx in the project, and Plumb loads the config with it.`,
    };
  }
  if (code === 'ERR_MODULE_NOT_FOUND') {
    if (tsx) return { code: 'unresolved-import', message: `${message} (loaded with tsx).` };
    const hint = message.startsWith('Cannot find package')
      ? 'Node does not read tsconfig paths, so a path alias cannot be used; import the file by its relative path, or install the package.'
      : 'Node resolves imports as written, so a relative import needs its .ts extension.';
    return { code: 'unresolved-import', message: `${message}. ${hint} ${install}` };
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
    ...checkProject(record.project),
    ...checkCheck(record.check),
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

function checkCheck(check: unknown): ConfigError[] {
  if (check === undefined) return [];
  if (typeof check !== 'object' || check === null || Array.isArray(check)) {
    return [{ code: 'invalid-type', path: 'check', message: '"check" must be an object.' }];
  }
  const errors: ConfigError[] = Object.keys(check)
    .filter((key) => !['tsconfig', 'baseline', 'ignore'].includes(key))
    .map((key) => ({
      code: 'unknown-key',
      path: `check.${key}`,
      message: `Unknown config key "check.${key}".`,
    }));
  const { tsconfig, baseline, ignore } = check as Record<string, unknown>;
  const strings = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === 'string');
  const invalid = (key: string, expected: string): ConfigError => ({
    code: 'invalid-check',
    path: `check.${key}`,
    message: `"check.${key}" must be ${expected}.`,
  });
  if (!(typeof tsconfig === 'string' || (strings(tsconfig) && (tsconfig as string[]).length > 0))) {
    errors.push(invalid('tsconfig', 'a tsconfig path, or a list of them'));
  }
  if (baseline !== undefined && typeof baseline !== 'string') {
    errors.push(invalid('baseline', 'a path'));
  }
  if (ignore !== undefined && !strings(ignore)) errors.push(invalid('ignore', 'a list of globs'));
  return errors;
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
    errors.push(...checkSettings(environment.settings, `${at}.settings`));
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

function checkSettings(settings: unknown, at: string): ConfigError[] {
  if (settings === undefined) return [];
  if (!isObject(settings)) {
    return [{ code: 'invalid-type', path: at, message: `"${at}" must be an object.` }];
  }
  return Object.entries(settings)
    .filter(([, value]) =>
      typeof value === 'number'
        ? !Number.isFinite(value)
        : !['string', 'boolean'].includes(typeof value),
    )
    .map(([name]) => ({
      code: 'invalid-setting' as const,
      path: `${at}.${name}`,
      message: `"${at}.${name}" must be a string, boolean or number, the types a ProjectSetting holds.`,
    }));
}

function checkProject(project: unknown): ConfigError[] {
  if (project === undefined) return [];
  if (!isObject(project)) return [notObject('project')];
  const errors: ConfigError[] = Object.keys(project)
    .filter((key) => !PROJECT_KEYS.includes(key))
    .map((key) =>
      SUPER_ADMIN_FIELDS.includes(key)
        ? {
            code: 'super-admin-field',
            path: `project.${key}`,
            message: `"project.${key}" can only be written by a super admin, so push cannot set it; push reports its live value instead.`,
          }
        : {
            code: 'unknown-key',
            path: `project.${key}`,
            message: `Unknown config key "project.${key}".`,
          },
    );
  const policies = isObject(project.accessPolicies) ? project.accessPolicies : {};
  const checkPolicyKey = (key: unknown, path: string): ConfigError[] =>
    typeof key === 'string' && Object.hasOwn(policies, key)
      ? []
      : [
          {
            code: 'unknown-access-policy',
            path,
            message: `"${path}" names ${JSON.stringify(key)}, which is not a key in project.accessPolicies.`,
          },
        ];
  return [
    ...errors,
    ...checkSettings(project.settings, 'project.settings'),
    ...checkSecrets(project.secrets),
    ...checkAccessPolicies(project.accessPolicies),
    ...checkDefaultAccessPolicies(project.defaultAccessPolicies, checkPolicyKey),
    ...checkClients(project.clients, checkPolicyKey),
  ];
}

const notObject = (path: string): ConfigError => ({
  code: 'invalid-type',
  path,
  message: `"${path}" must be an object.`,
});

type CheckPolicyKey = (key: unknown, path: string) => ConfigError[];

function checkSecrets(secrets: unknown): ConfigError[] {
  if (secrets === undefined) return [];
  if (!isObject(secrets)) return [notObject('project.secrets')];
  return Object.entries(secrets)
    .filter(
      ([, secret]) =>
        secret !== true &&
        !(isObject(secret) && typeof secret.env === 'string' && secret.env !== ''),
    )
    .map(([name]) => ({
      code: 'invalid-type' as const,
      path: `project.secrets.${name}`,
      message: `"project.secrets.${name}" must be { env: 'VAR' }, naming the variable that holds its value, or true for one set by hand: the config is committed, so it never holds the value.`,
    }));
}

function checkAccessPolicies(accessPolicies: unknown): ConfigError[] {
  if (accessPolicies === undefined) return [];
  if (!isObject(accessPolicies)) return [notObject('project.accessPolicies')];
  const errors: ConfigError[] = [];
  // push adopts an untagged policy by its name, so two policies cannot share one.
  const names = new Map<string, string>();
  for (const [key, policy] of Object.entries(accessPolicies)) {
    const at = `project.accessPolicies.${key}`;
    if (!isObject(policy)) {
      errors.push(notObject(at));
      continue;
    }
    const name = typeof policy.name === 'string' ? policy.name : key;
    const other = names.get(name);
    if (other !== undefined) {
      errors.push({
        code: 'duplicate-key',
        path: `${at}.name`,
        message: `"${key}" and "${other}" are both named "${name}".`,
      });
    }
    names.set(name, key);
  }
  return errors;
}

function checkDefaultAccessPolicies(rows: unknown, checkPolicyKey: CheckPolicyKey): ConfigError[] {
  if (rows === undefined) return [];
  if (!Array.isArray(rows)) {
    return [
      {
        code: 'invalid-type',
        path: 'project.defaultAccessPolicies',
        message: '"project.defaultAccessPolicies" must be a list.',
      },
    ];
  }
  const seen = new Set<unknown>();
  return rows.flatMap((row: unknown, i): ConfigError[] => {
    const at = `project.defaultAccessPolicies[${i}]`;
    if (!isObject(row)) return [notObject(at)];
    const errors = checkPolicyKey(row.accessPolicy, `${at}.accessPolicy`);
    const { profileType } = row;
    if (
      typeof profileType !== 'string' ||
      !(PROFILE_TYPES as readonly string[]).includes(profileType)
    ) {
      errors.unshift({
        code: 'invalid-type',
        path: `${at}.profileType`,
        message: `"${at}.profileType" must be one of ${PROFILE_TYPES.join(', ')}.`,
      });
    } else if (seen.has(profileType)) {
      errors.unshift({
        code: 'duplicate-key',
        path: `${at}.profileType`,
        message: `"${profileType}" has more than one default access policy.`,
      });
    }
    seen.add(profileType);
    return errors;
  });
}

function checkClients(clients: unknown, checkPolicyKey: CheckPolicyKey): ConfigError[] {
  if (clients === undefined) return [];
  if (!isObject(clients)) return [notObject('project.clients')];
  return Object.entries(clients).flatMap(([key, client]): ConfigError[] => {
    const at = `project.clients.${key}`;
    if (!isObject(client)) return [notObject(at)];
    const errors: ConfigError[] = Object.keys(client)
      .filter((field) => field !== 'accessPolicy' && field !== 'admin')
      .map((field) => ({
        code: 'unknown-key',
        path: `${at}.${field}`,
        message: `Unknown config key "${at}.${field}".`,
      }));
    if (client.accessPolicy !== undefined) {
      errors.push(...checkPolicyKey(client.accessPolicy, `${at}.accessPolicy`));
    }
    if (client.admin !== undefined && typeof client.admin !== 'boolean') {
      errors.push({
        code: 'invalid-type',
        path: `${at}.admin`,
        message: `"${at}.admin" must be a boolean.`,
      });
    }
    return errors;
  });
}

/**
 * An environment's settings merged over `project.settings`, the values `push`
 * writes there.
 */
export function environmentSettings(config: PlumbConfig, name: string): Settings {
  return { ...config.project?.settings, ...config.environments?.[name]?.settings };
}

export interface ConfigWarning {
  code: 'writable-wildcard' | 'admin-without-policy' | 'writes-structure-definition';
  path: string;
  message: string;
}

const WRITES = ['create', 'update', 'delete'];
const writes = (entry: AccessPolicyResource) =>
  !entry.readonly && (entry.interaction ?? WRITES).some((i) => WRITES.includes(i));

/**
 * Where the project config departs from the lockdown recipe: warnings, since a
 * project may need the access. `ownPolicy` is the key of the policy `push`
 * itself runs under, which has to write StructureDefinition.
 */
export function lockdownWarnings(project: ProjectConfig, ownPolicy?: string): ConfigWarning[] {
  const warnings: ConfigWarning[] = [];
  for (const [key, policy] of Object.entries(project.accessPolicies ?? {})) {
    (policy.resource ?? []).forEach((entry, i) => {
      const path = `project.accessPolicies.${key}.resource[${i}]`;
      if (!writes(entry)) return;
      if (entry.resourceType === '*') {
        warnings.push({
          code: 'writable-wildcard',
          path,
          message: `"${key}" has a writable * entry: entries are a union, so it re-opens every type.`,
        });
      } else if (entry.resourceType === 'StructureDefinition' && key !== ownPolicy) {
        warnings.push({
          code: 'writes-structure-definition',
          path,
          message: `"${key}" writes StructureDefinition, which bypasses push's profile gate.`,
        });
      }
    });
  }
  for (const [key, client] of Object.entries(project.clients ?? {})) {
    if (client.admin === true && client.accessPolicy === undefined) {
      warnings.push({
        code: 'admin-without-policy',
        path: `project.clients.${key}`,
        message: `"${key}" is an admin with no accessPolicy, which gives it full access.`,
      });
    }
  }
  return warnings;
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

function resolveCheck(base: string, check: CheckConfig): ResolvedCheckConfig {
  return {
    tsconfig: [check.tsconfig].flat().map((path) => resolve(base, path)),
    ...(check.baseline ? { baseline: resolve(base, check.baseline) } : {}),
    ignore: check.ignore ?? [],
  };
}
