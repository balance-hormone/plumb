// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { existsSync, globSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Script } from 'node:vm';
import {
  type Filter,
  getSearchParameter,
  indexSearchParameterBundle,
  indexStructureDefinitionBundle,
  isResourceType,
  normalizeErrorString,
  parseFhirPath,
  parseSearchRequest,
  type SearchRequest,
} from '@medplum/core';
import { readJson, SEARCH_PARAMETER_BUNDLE_FILES } from '@medplum/definitions';
import type {
  AccessPolicy,
  AccessPolicyResource,
  Bot,
  Bundle,
  Coding,
  SearchParameter,
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
  /** The test environment: a server Plumb starts and a project `push` converges in it. */
  test?: TestConfig;
  /**
   * Reference content `push` converges: files or globs of Questionnaire,
   * CodeSystem, ValueSet and Organization JSON, one resource each.
   */
  content?: string[];
  /** Bots `push` creates, configures and deploys, by key: the key is the bot's identity. */
  bots?: Record<string, BotConfig>;
  /** Subscriptions `push` converges, by key, each delivering to a bot or a URL. */
  subscriptions?: Record<string, SubscriptionConfig>;
  /**
   * Modules, as paths or globs, whose exports made by `defineOperation` are
   * the project's operations; `generate` writes the contract functions when
   * any are listed.
   */
  operations?: string[];
  /** Data migrations: the modules that declare them and the bot that runs them. */
  migrations?: MigrationsConfig;
}

/** Where a project's data migrations are declared, and the bot that runs them. */
export interface MigrationsConfig {
  /** The key in `bots` of the bot built from the generated runner. */
  bot: string;
  /** Modules, as paths or globs, each default-exporting a `defineMigration`. */
  modules: string[];
  /** Adds Plumb's restamp migration, for every type with routing rows. */
  restamp?: boolean;
}

/** A bot: its built bundle and the Bot's own fields, written as declared. */
export interface BotConfig {
  /** The project's built bundle, deployed as is. */
  file: string;
  /** The key unless given. */
  name?: string;
  /** `awslambda` by default, Medplum's own. */
  runtime?: Bot['runtimeVersion'];
  /** Seconds; 10 by default, always written, so `$deploy` never fills one in. */
  timeout?: number;
  /** The key in `project.accessPolicies` of the bot's own membership's policy. */
  policy?: string;
  /** The keys in `project.secrets` the bot reads. */
  secrets?: string[];
  /** A schedule, as Medplum's five-field `cronString`. */
  cron?: string;
  runAsUser?: boolean;
  admin?: boolean;
  publicWebhook?: boolean;
  rawBody?: boolean;
  audit?: { trigger?: Bot['auditEventTrigger']; destination?: Bot['auditEventDestination'] };
  /**
   * The keys in `environments` this bot is deployed to; every environment
   * unless given. A test project runs every bot.
   */
  environments?: string[];
}

/** A Subscription, delivering to a bot or to an `https` URL. */
export interface SubscriptionConfig {
  /** A search, as `Appointment?status=booked`, that Medplum's matcher can fire on. */
  criteria: string;
  /** All three unless given. */
  interactions?: ('create' | 'update' | 'delete')[];
  /** A FHIRPath that must be true, with `%previous` and `%current`. */
  fhirPath?: string;
  /** The key in `bots` to run. */
  bot?: string;
  url?: string;
  /** The variable holding the key that signs each delivery as `X-Signature`. */
  secret?: { env: string };
  /** Each header's value by the variable that holds it, since one usually carries a token. */
  headers?: Record<string, { env: string }>;
  /** Delivery attempts to the URL, at most 18; Medplum's default is 4. */
  maxAttempts?: number;
  /**
   * The keys in `environments` this Subscription is written to: by default its
   * bot's, or every environment for a URL.
   */
  environments?: string[];
}

/**
 * What a test project has beyond what `push` writes. The test server's super
 * admin sets `strictMode` and `features`, which `project` cannot.
 */
export interface TestConfig {
  /** The Medplum server release, as `5.1.42`; by default the installed `@medplum/core`'s. */
  server?: string;
  /** `true` by default; `false` rehearses a loose project. */
  strictMode?: boolean;
  /** The project's features; `['bots']` by default, with `cron` when a bot has a schedule. */
  features?: string[];
  /** Merged over `project.settings`, as an environment's are. */
  settings?: Settings;
  /** Transaction or batch Bundles, as paths or globs, loaded in order after the push. */
  seed?: string[];
  /**
   * A test build for a bot, by key, for one whose bundle needs packages only a
   * Lambda layer has: the test server runs every bot on vmcontext.
   */
  bots?: Record<string, { file: string }>;
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
   * `environments` keeps a secret out of every other environment, where one
   * found is removed with `--prune`.
   */
  secrets?: Record<string, { env: string; environments?: string[] } | true>;
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

export type AccessPolicyConfig = Omit<AccessPolicy, 'resourceType' | 'id' | 'meta' | 'resource'> & {
  resource?: AccessPolicyEntry[];
};

/**
 * An AccessPolicy entry, where a `Bot` entry may name bots by key: push
 * writes them as criteria on Plumb's identifier, so the policy holds no id.
 */
export type AccessPolicyEntry = AccessPolicyResource & { bots?: string[] };

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
  /**
   * The project holds no real patient data, so migrations may run in the
   * CLI's own process as well as in the project's bot.
   */
  synthetic?: boolean;
}

/** An environment with its credentials read from the environment variables. */
export interface ResolvedEnvironment {
  name: string;
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  /** Holds no real patient data, as the config or a test project says. */
  synthetic?: boolean;
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
  | 'invalid-check'
  | 'invalid-server-version'
  | 'invalid-bot'
  | 'invalid-subscription'
  | 'unknown-bot'
  | 'invalid-operation'
  | 'invalid-migration';

export interface ConfigError {
  code: ConfigErrorCode;
  message: string;
  /** The config key the error is about. */
  path?: string;
}

declare const loaded: unique symbol;

/**
 * A config as `loadConfig` resolves it: paths absolute against its folder,
 * `local` set from `fsh`. What `createTestProject` and `migrate` need; only
 * `loadConfig` makes one.
 */
export type LoadedConfig = PlumbConfig & { readonly [loaded]: true };

export type LoadConfigResult =
  | { ok: true; configPath: string; config: LoadedConfig }
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
  'test',
  'content',
  'bots',
  'subscriptions',
  'operations',
  'migrations',
]);
const ENVIRONMENT_KEYS = ['baseUrl', 'clientId', 'clientSecret', 'settings', 'synthetic'] as const;
const PROJECT_KEYS = ['settings', 'secrets', 'accessPolicies', 'defaultAccessPolicies', 'clients'];
const TEST_KEYS = ['server', 'strictMode', 'features', 'settings', 'seed', 'bots'];
// A project admin's write to these is silently restored, so declaring one would never take.
const SUPER_ADMIN_FIELDS = ['strictMode', 'features', 'link', 'systemSetting'];
// Medplum's member roles; @medplum/fhirtypes 5.1 has no type for them yet.
const PROFILE_TYPES = ['Patient', 'Practitioner', 'RelatedPerson', 'Admin'] as const;
// FHIR package names are lowercase dotted segments; versions are exact, never ranges.
const NAME = '[a-z0-9][a-z0-9-]*(?:\\.[a-z0-9][a-z0-9-]*)+';
const IG = new RegExp(`^(${NAME})@\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?$`);
// The version lives in igs, so a wildcard names the package alone.
const ALL_PROFILES = new RegExp(`^(${NAME})/\\*$`);

/** A SUSHI project's config file, by name: SUSHI accepts either extension. */
export function sushiConfig(project: string): string | undefined {
  return ['sushi-config.yaml', 'sushi-config.yml'].find((name) => existsSync(join(project, name)));
}

/**
 * Loads `plumb.config.ts` from `cwd`, or `configPath` relative to it, with
 * Node's type stripping, or the project's own tsx for what Node cannot load.
 * `local`, `fsh`, `out`, `content`, `operations`, `migrations.modules`, `test.seed` and each bot's
 * `file` come back as absolute paths, resolved against the config file's folder; with `fsh`, `local` is its
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

  const imported = await importConfig(configPath);
  if ('error' in imported) return fail(imported.error);
  const { module } = imported;
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
  if (fsh && !sushiConfig(fsh)) {
    return fail({
      code: 'no-sushi-config',
      path: 'fsh',
      message: `"fsh" names ${fsh}, which has no sushi-config.yaml or sushi-config.yml. It must be the folder of a SUSHI project.`,
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
      ...resolveList(base, config, 'content'),
      ...resolveList(base, config, 'operations'),
      ...(config.migrations
        ? {
            migrations: {
              ...config.migrations,
              modules: config.migrations.modules.map((p) => resolve(base, p)),
            },
          }
        : {}),
      ...resolveBots(base, config.bots),
      ...(config.test ? { test: resolveTest(base, config.test) } : {}),
      ...(fsh ? { fsh } : {}),
      ...(local ? { local } : {}),
    } as LoadedConfig,
  };
}

/**
 * Imports each module the paths or globs match, as the config is imported.
 * A pattern that matches nothing, or a module that does not load, is an error
 * with `code` at `key`.
 */
export async function importModules(
  paths: string[],
  key: string,
  code: ConfigErrorCode,
): Promise<
  | { ok: true; modules: { file: string; module: Record<string, unknown> }[] }
  | { ok: false; errors: ConfigError[] }
> {
  const modules: { file: string; module: Record<string, unknown> }[] = [];
  const errors: ConfigError[] = [];
  for (const pattern of paths) {
    const files = globSync(pattern).sort();
    if (files.length === 0) {
      errors.push({ code, path: key, message: `"${pattern}" matches no file.` });
    }
    for (const file of files) {
      const imported = await importConfig(file);
      if ('error' in imported) {
        const { error } = imported;
        errors.push({ ...error, path: key, message: `${file}: ${error.message}` });
      } else {
        modules.push({ file, module: imported.module as Record<string, unknown> });
      }
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, modules };
}

/**
 * Imports the config, or a module it names, with Node, or with the project's
 * tsx for what Node cannot load: tsx's esbuild breaks in some environments
 * that load the config, such as a jsdom test. Errors Plumb can name come
 * back; others throw.
 */
async function importConfig(
  configPath: string,
): Promise<{ module: { default?: unknown } } | { error: ConfigError }> {
  const url = pathToFileURL(configPath).href;
  // Keyed by content, so a module edited since this process last imported it
  // loads again rather than from Node's cache. tsx imports afresh each call.
  const version = createHash('sha256').update(readFileSync(configPath)).digest('hex').slice(0, 16);
  try {
    return { module: await import(`${url}?v=${version}`) };
  } catch (err) {
    const error = importError(err, false);
    if (!error) throw err;
    const tsx = findTsx(configPath);
    if (!tsx) return { error };
    const tsconfig = nearest(configPath, 'tsconfig.json');
    try {
      return {
        module: await tsx.tsImport(url, { parentURL: url, ...(tsconfig ? { tsconfig } : {}) }),
      };
    } catch (err) {
      const error = importError(err, true);
      if (error) return { error };
      throw err;
    }
  }
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
    ...checkProject(record.project, record),
    ...checkCheck(record.check),
    ...checkTest(record.test),
  );
  errors.push(
    ...checkPaths(record.content, 'content'),
    ...checkPaths(record.operations, 'operations'),
  );
  errors.push(
    ...checkBots(record),
    ...checkBotGrants(record),
    ...checkTestBots(record),
    ...checkSubscriptions(record),
    ...checkMigrationsConfig(record),
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
    if (environment.synthetic !== undefined && typeof environment.synthetic !== 'boolean') {
      errors.push({
        code: 'invalid-type',
        path: `${at}.synthetic`,
        message: `"${at}.synthetic" must be true or false.`,
      });
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

function checkProject(project: unknown, config: Record<string, unknown>): ConfigError[] {
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
    ...checkSecrets(project.secrets, config),
    ...checkAccessPolicies(project.accessPolicies),
    ...checkDefaultAccessPolicies(project.defaultAccessPolicies, checkPolicyKey),
    ...checkClients(project.clients, checkPolicyKey),
  ];
}

function checkPaths(paths: unknown, key: 'content' | 'operations'): ConfigError[] {
  if (paths === undefined) return [];
  if (Array.isArray(paths) && paths.every((p) => typeof p === 'string')) return [];
  return [
    {
      code: 'invalid-type',
      path: key,
      message: `"${key}" must be a list of paths or globs.`,
    },
  ];
}

function checkTest(test: unknown): ConfigError[] {
  if (test === undefined) return [];
  if (!isObject(test)) return [notObject('test')];
  const errors: ConfigError[] = Object.keys(test)
    .filter((key) => !TEST_KEYS.includes(key))
    .map((key) => ({
      code: 'unknown-key',
      path: `test.${key}`,
      message: `Unknown config key "test.${key}".`,
    }));
  // Medplum's server images are tagged by release, never by range.
  if (test.server !== undefined && !/^\d+\.\d+\.\d+$/.test(String(test.server))) {
    errors.push({
      code: 'invalid-server-version',
      path: 'test.server',
      message: `"test.server" must be a Medplum release, as 5.1.42.`,
    });
  }
  if (test.strictMode !== undefined && typeof test.strictMode !== 'boolean') {
    errors.push({
      code: 'invalid-type',
      path: 'test.strictMode',
      message: '"test.strictMode" must be true or false.',
    });
  }
  for (const key of ['features', 'seed']) {
    const list = test[key];
    if (list !== undefined && !(Array.isArray(list) && list.every((i) => typeof i === 'string'))) {
      errors.push({
        code: 'invalid-type',
        path: `test.${key}`,
        message: `"test.${key}" must be a list of strings.`,
      });
    }
  }
  return [...errors, ...checkSettings(test.settings, 'test.settings')];
}

const notObject = (path: string): ConfigError => ({
  code: 'invalid-type',
  path,
  message: `"${path}" must be an object.`,
});

type CheckPolicyKey = (key: unknown, path: string) => ConfigError[];

function checkSecrets(secrets: unknown, config: Record<string, unknown>): ConfigError[] {
  if (secrets === undefined) return [];
  if (!isObject(secrets)) return [notObject('project.secrets')];
  return Object.entries(secrets).flatMap(([name, secret]): ConfigError[] => {
    const at = `project.secrets.${name}`;
    if (secret === true) return [];
    if (!(isObject(secret) && typeof secret.env === 'string' && secret.env !== '')) {
      return [
        {
          code: 'invalid-type',
          path: at,
          message: `"${at}" must be { env: 'VAR' }, naming the variable that holds its value, or true for one set by hand: the config is committed, so it never holds the value.`,
        },
      ];
    }
    const { environments } = secret;
    if (environments !== undefined && !isListOf(isText)(environments)) {
      return [
        {
          code: 'invalid-type',
          path: `${at}.environments`,
          message: `"${at}.environments" must be a list of keys in environments.`,
        },
      ];
    }
    return [
      ...unknownKeys(secret, { env: 0, environments: 0 }, at),
      ...scopeProblems(environments, config).map(toError('invalid-type', at)),
    ];
  });
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

const isBoolean = (value: unknown) => typeof value === 'boolean';
const isText = (value: unknown) => typeof value === 'string' && value !== '';
const isEnv = (value: unknown) => isObject(value) && isText(value.env);
const oneOf = (values: readonly unknown[]) => (value: unknown) => values.includes(value);
const isListOf = (valid: (item: unknown) => boolean) => (value: unknown) =>
  Array.isArray(value) && value.length > 0 && value.every(valid);

const isAudit = (audit: unknown) =>
  isObject(audit) &&
  Object.keys(audit).every((key) => key === 'trigger' || key === 'destination') &&
  (audit.trigger === undefined ||
    oneOf(['always', 'never', 'on-error', 'on-output'])(audit.trigger)) &&
  (audit.destination === undefined || isListOf(oneOf(['log', 'resource']))(audit.destination));

// Each field of a bot, with what it must be.
const BOT_FIELDS: Record<keyof BotConfig, [(value: unknown) => boolean, string]> = {
  file: [isText, 'the path of the built bundle'],
  name: [isText, 'a name'],
  runtime: [oneOf(['awslambda', 'vmcontext', 'fission']), 'awslambda, vmcontext or fission'],
  timeout: [(v) => Number.isInteger(v) && (v as number) > 0, 'a whole number of seconds'],
  policy: [isText, 'a key in project.accessPolicies'],
  secrets: [isListOf(isText), 'a list of keys in project.secrets'],
  cron: [isText, 'a five-field cron schedule'],
  runAsUser: [isBoolean, 'true or false'],
  admin: [isBoolean, 'true or false'],
  publicWebhook: [isBoolean, 'true or false'],
  rawBody: [isBoolean, 'true or false'],
  audit: [
    isAudit,
    "{ trigger, destination }, as the Bot's auditEventTrigger and auditEventDestination",
  ],
  environments: [isListOf(isText), 'a list of keys in environments'],
};

const unknownKeys = (record: Record<string, unknown>, known: object, at: string): ConfigError[] =>
  Object.keys(record)
    .filter((key) => !Object.hasOwn(known, key))
    .map((key) => ({
      code: 'unknown-key',
      path: `${at}.${key}`,
      message: `Unknown config key "${at}.${key}".`,
    }));

const keysOf = (value: unknown) => (isObject(value) ? value : {});

/** A field's path within an entry, or the entry's own for `''`, and what is wrong with it. */
type Problem = [field: string, message: string];

const toError =
  (code: ConfigErrorCode, at: string) =>
  ([field, message]: Problem): ConfigError => {
    const path = field ? `${at}.${field}` : at;
    return { code, path, message: `"${path}" ${message}.` };
  };

function checkBots(config: Record<string, unknown>): ConfigError[] {
  const { bots } = config;
  if (bots === undefined) return [];
  if (!isObject(bots)) return [notObject('bots')];
  const project = keysOf(config.project);
  // push adopts an untagged bot by its name, so two bots cannot share one.
  const names = new Map<string, string>();
  return Object.entries(bots).flatMap(([key, bot]): ConfigError[] => {
    const at = `bots.${key}`;
    if (!isObject(bot)) return [notObject(at)];
    if (key === 'checker') {
      return [
        {
          code: 'invalid-bot',
          path: at,
          message: `"${at}" is the key of Plumb's own checker bot.`,
        },
      ];
    }
    const errors = [
      ...unknownKeys(bot, BOT_FIELDS, at),
      ...[...checkBot(bot, project), ...scopeProblems(bot.environments, config)].map(
        toError('invalid-bot', at),
      ),
    ];
    const name = isText(bot.name) ? (bot.name as string) : key;
    const other = names.get(name);
    if (other !== undefined) {
      errors.push({
        code: 'duplicate-key',
        path: `${at}.name`,
        message: `"${key}" and "${other}" are both named "${name}".`,
      });
    }
    names.set(name, key);
    return errors;
  });
}

function checkBot(bot: Record<string, unknown>, project: Record<string, unknown>): Problem[] {
  const problems = Object.entries(BOT_FIELDS).flatMap(([field, [valid, expected]]): Problem[] => {
    const value = bot[field];
    if (value === undefined && field !== 'file') return [];
    return valid(value) ? botReferences(field, value, project) : [[field, `must be ${expected}`]];
  });
  if (bot.publicWebhook === true && bot.policy === undefined) {
    problems.push([
      'publicWebhook',
      'needs a policy: Medplum answers a webhook to a bot without one with a 403',
    ]);
  }
  return problems;
}

/** The keys a bot names and the schedule it runs, once each is well formed. */
function botReferences(field: string, value: unknown, project: Record<string, unknown>): Problem[] {
  const missing = (key: string, where: string, at = field): Problem[] =>
    Object.hasOwn(keysOf(project[where]), key)
      ? []
      : [[at, `names "${key}", which is not a key in project.${where}`]];
  if (field === 'policy') return missing(value as string, 'accessPolicies');
  if (field === 'secrets') {
    return (value as string[]).flatMap((secret, i) => missing(secret, 'secrets', `secrets[${i}]`));
  }
  if (field === 'cron' && !isValidCron(value as string)) {
    return [[field, 'is not a schedule Medplum runs: it ignores an invalid one']];
  }
  return [];
}

/** Each environment a scope names is one the config declares. */
function scopeProblems(environments: unknown, config: Record<string, unknown>): Problem[] {
  if (!isListOf(isText)(environments)) return [];
  const declared = keysOf(config.environments);
  return (environments as string[])
    .filter((name) => !Object.hasOwn(declared, name))
    .map((name) => ['environments', `names "${name}", which is not a key in environments`]);
}

const MIGRATIONS_FIELDS = { bot: 1, modules: 1, restamp: 1 };

function checkMigrationsConfig(config: Record<string, unknown>): ConfigError[] {
  const { migrations } = config;
  if (migrations === undefined) return [];
  if (!isObject(migrations)) return [notObject('migrations')];
  const errors = unknownKeys(migrations, MIGRATIONS_FIELDS, 'migrations');
  const invalidType = (field: string, expected: string): ConfigError => ({
    code: 'invalid-type',
    path: `migrations.${field}`,
    message: `"migrations.${field}" must be ${expected}.`,
  });
  if (!isText(migrations.bot)) {
    errors.push(invalidType('bot', 'the key in bots of the bot that runs migrations'));
  } else if (!Object.hasOwn(keysOf(config.bots), migrations.bot as string)) {
    errors.push({
      code: 'invalid-migration',
      path: 'migrations.bot',
      message: `"migrations.bot" names "${migrations.bot}", which is not a key in bots.`,
    });
  } else if (keysOf(keysOf(config.bots)[migrations.bot as string]).environments !== undefined) {
    errors.push({
      code: 'invalid-migration',
      path: 'migrations.bot',
      message: `"migrations.bot" names "${migrations.bot}", which has environments: migrations run in every environment.`,
    });
  }
  if (!isListOf(isText)(migrations.modules)) {
    errors.push(invalidType('modules', 'a list of paths or globs'));
  }
  if (migrations.restamp !== undefined && typeof migrations.restamp !== 'boolean') {
    errors.push(invalidType('restamp', 'true or false'));
  }
  return errors;
}

/** Each test build names a declared bot and its bundle. */
function checkTestBots(config: Record<string, unknown>): ConfigError[] {
  const builds = keysOf(config.test).bots;
  if (builds === undefined) return [];
  if (!isObject(builds)) return [notObject('test.bots')];
  const bots = keysOf(config.bots);
  return Object.entries(builds).flatMap(([key, build]): ConfigError[] => {
    const path = `test.bots.${key}`;
    if (!Object.hasOwn(bots, key)) {
      return [
        {
          code: 'unknown-bot',
          path,
          message: `"${path}" names "${key}", which is not a key in bots.`,
        },
      ];
    }
    if (!isObject(build) || !isText(build.file) || Object.keys(build).some((k) => k !== 'file')) {
      return [
        {
          code: 'invalid-type',
          path,
          message: `"${path}" must be { file }, the path of the bot's test build.`,
        },
      ];
    }
    return [];
  });
}

/** Each policy entry that names bots by key: a Bot entry, without its own criteria, naming declared bots. */
function checkBotGrants(config: Record<string, unknown>): ConfigError[] {
  const policies = keysOf(keysOf(config.project).accessPolicies);
  const bots = keysOf(config.bots);
  return Object.entries(policies).flatMap(([key, policy]) => {
    const entries = keysOf(policy).resource;
    if (!Array.isArray(entries)) return [];
    return entries.flatMap((entry: unknown, i): ConfigError[] => {
      if (!isObject(entry) || entry.bots === undefined) return [];
      const path = `project.accessPolicies.${key}.resource[${i}].bots`;
      if (
        !isListOf(isText)(entry.bots) ||
        entry.resourceType !== 'Bot' ||
        entry.criteria !== undefined
      ) {
        return [
          {
            code: 'invalid-type',
            path,
            message: `"${path}" must be a list of keys in bots, on a Bot entry without criteria.`,
          },
        ];
      }
      // Plumb's own checker is granted by key too: the migration bot runs it.
      return (entry.bots as string[])
        .filter((bot) => bot !== 'checker' && !Object.hasOwn(bots, bot))
        .map((bot) => ({
          code: 'unknown-bot' as const,
          path,
          message: `"${path}" names "${bot}", which is not a key in bots.`,
        }));
    });
  });
}

const SUBSCRIPTION_FIELDS = {
  criteria: 0,
  interactions: 0,
  fhirPath: 0,
  bot: 0,
  url: 0,
  secret: 0,
  headers: 0,
  maxAttempts: 0,
  environments: 0,
} satisfies Record<keyof SubscriptionConfig, 0>;

const VARIABLE =
  "must be { env: 'VAR' }, naming the variable that holds it: the config is committed, so it never holds the value";

function checkSubscriptions(config: Record<string, unknown>): ConfigError[] {
  const { subscriptions } = config;
  if (subscriptions === undefined) return [];
  if (!isObject(subscriptions)) return [notObject('subscriptions')];
  const bots = keysOf(config.bots);
  return Object.entries(subscriptions).flatMap(([key, subscription]): ConfigError[] => {
    const at = `subscriptions.${key}`;
    if (!isObject(subscription)) return [notObject(at)];
    const problems = [
      ...matchProblems(subscription),
      ...deliveryProblems(subscription, bots),
      ...subscriptionScopeProblems(subscription, config),
    ];
    return [
      ...unknownKeys(subscription, SUBSCRIPTION_FIELDS, at),
      ...problems.map(toError('invalid-subscription', at)),
    ];
  });
}

/** What selects the resources a Subscription fires on. */
function matchProblems({ criteria, interactions, fhirPath }: Record<string, unknown>): Problem[] {
  const problems: Problem[] = [];
  if (!isText(criteria)) {
    problems.push(['criteria', 'must be a search, as Appointment?status=booked']);
  } else {
    const reason = checkCriteria(criteria as string);
    if (reason) problems.push(['criteria', `can never fire: ${reason}`]);
  }
  if (
    interactions !== undefined &&
    !isListOf(oneOf(['create', 'update', 'delete']))(interactions)
  ) {
    problems.push(['interactions', 'must be a list of create, update and delete']);
  }
  if (fhirPath !== undefined) {
    const error = isText(fhirPath) ? parseError(() => parseFhirPath(fhirPath as string)) : '';
    if (error !== undefined) problems.push(['fhirPath', `is not FHIRPath ${error}`.trim()]);
  }
  return problems;
}

/**
 * A Subscription's environments are declared ones, and only ones its bot is
 * deployed to: elsewhere it would deliver to no bot.
 */
function subscriptionScopeProblems(
  { environments, bot }: Record<string, unknown>,
  config: Record<string, unknown>,
): Problem[] {
  if (environments === undefined) return [];
  if (!isListOf(isText)(environments)) {
    return [['environments', 'must be a list of keys in environments']];
  }
  const scope = typeof bot === 'string' ? keysOf(keysOf(config.bots)[bot]).environments : undefined;
  const outside = isListOf(isText)(scope)
    ? (environments as string[]).filter((name) => !(scope as string[]).includes(name))
    : [];
  return [
    ...scopeProblems(environments, config),
    ...outside.map(
      (name): Problem => ['environments', `includes "${name}", where bot "${bot}" is not deployed`],
    ),
  ];
}

/** Where a Subscription delivers: a declared bot, or an https URL with its own settings. */
function deliveryProblems(subscription: Record<string, unknown>, bots: object): Problem[] {
  const { bot, url, secret, headers, maxAttempts } = subscription;
  if ((bot === undefined) === (url === undefined)) {
    return [['', 'must name a bot or a url, one of the two']];
  }
  if (bot !== undefined) {
    const known = typeof bot === 'string' && Object.hasOwn(bots, bot);
    return [
      ...(known
        ? []
        : [['bot', `names ${JSON.stringify(bot)}, which is not a key in bots`] as Problem]),
      ...['secret', 'headers', 'maxAttempts']
        .filter((field) => subscription[field] !== undefined)
        .map((field): Problem => [field, 'applies only to delivery to a url, not to a bot']),
    ];
  }
  return [
    ...(URL.parse(String(url))?.protocol === 'https:'
      ? []
      : [['url', 'must be an https URL'] as Problem]),
    ...maxAttemptsProblems(maxAttempts),
    ...(secret === undefined || isEnv(secret) ? [] : [['secret', VARIABLE] as Problem]),
    ...headerProblems(headers),
  ];
}

function maxAttemptsProblems(maxAttempts: unknown): Problem[] {
  if (maxAttempts === undefined) return [];
  if (!(Number.isInteger(maxAttempts) && (maxAttempts as number) >= 1)) {
    return [['maxAttempts', 'must be a whole number of at least 1']];
  }
  return (maxAttempts as number) > 18
    ? [['maxAttempts', 'is over 18, the most Medplum attempts']]
    : [];
}

function headerProblems(headers: unknown): Problem[] {
  if (headers === undefined) return [];
  if (!isObject(headers)) return [['headers', 'must map header names to values']];
  return Object.entries(headers).flatMap(([name, value]): Problem[] => {
    const field = /^[\w-]+$/.test(name) ? `headers.${name}` : `headers[${JSON.stringify(name)}]`;
    // Medplum splits each header on every ':', so a name cannot hold one.
    if (!/^[!#$%&'*+.^_`|~\w-]+$/.test(name)) return [[field, 'is not a header name']];
    return isEnv(value) ? [] : [[field, VARIABLE]];
  });
}

const parseError = (parse: () => unknown): string | undefined => {
  try {
    parse();
    return undefined;
  } catch (err) {
    return `(${normalizeErrorString(err)})`;
  }
};

let serverSchemaIndexed = false;

/** What Medplum's server indexes at startup (`fhir/structure.ts`), so criteria parse and match as there. */
function indexServerSchema(): void {
  if (serverSchemaIndexed) return;
  for (const file of ['profiles-types', 'profiles-resources', 'profiles-medplum']) {
    indexStructureDefinitionBundle(readJson(`fhir/r4/${file}.json`) as Bundle);
  }
  for (const file of SEARCH_PARAMETER_BUNDLE_FILES) {
    indexSearchParameterBundle(readJson(file) as Bundle<SearchParameter>);
  }
  serverSchemaIndexed = true;
}

// The operators Medplum's matcher (`search/match.ts`) applies for each type it
// matches. It reads any other modifier or prefix as equality or never matches,
// and matches no other type. `missing` and `present` work on every type.
const MATCHED: Record<string, string[]> = {
  reference: ['eq', 'not'],
  string: ['eq', 'not', 'contains'],
  uri: ['eq', 'not'],
  token: ['eq', 'not'],
  date: ['eq', 'ne', 'lt', 'gt', 'le', 'ge', 'sa', 'eb'],
};

/**
 * Why Medplum's Subscription matcher can never fire on these criteria, or
 * nothing when it can.
 */
export function checkCriteria(criteria: string): string | undefined {
  indexServerSchema();
  let request: SearchRequest;
  try {
    request = parseSearchRequest(criteria);
  } catch (err) {
    return `Medplum cannot parse it (${normalizeErrorString(err)})`;
  }
  const type = request.resourceType;
  if (!isResourceType(type)) return `"${type}" is not a resource type`;
  for (const filter of request.filters ?? []) {
    const reason = filterProblem(type, filter);
    if (reason) return reason;
  }
  return undefined;
}

// The runner pages through a migration's records with these, and transforms
// whole records of the one type, so a search cannot set them.
const RUNNER_PARAMS = [
  '_sort',
  '_count',
  '_cursor',
  '_offset',
  '_summary',
  '_elements',
  '_include',
  '_revinclude',
];

/**
 * Why a migration's search cannot run as given: an unknown resource type, a
 * parameter the runner sets, or one Medplum does not index for the type.
 */
export function checkSearch(
  resourceType: string,
  search: Record<string, string>,
): string | undefined {
  indexServerSchema();
  if (!isResourceType(resourceType)) return `"${resourceType}" is not a resource type`;
  // Medplum reads these into the request itself, not its filters.
  const reserved = Object.keys(search).find((key) =>
    RUNNER_PARAMS.includes(key.split(':')[0] as string),
  );
  if (reserved) return `sets "${reserved}", which the runner sets`;
  const query = new URLSearchParams(search).toString();
  let request: SearchRequest;
  try {
    request = parseSearchRequest(`${resourceType}?${query}`);
  } catch (err) {
    return `Medplum cannot parse its search (${normalizeErrorString(err)})`;
  }
  for (const { code } of request.filters ?? []) {
    if (code.startsWith('_has:')) continue;
    const first = code.split('.')[0] as string;
    if (!getSearchParameter(resourceType, first)) {
      return `searches by "${first}", which Medplum does not index for ${resourceType}`;
    }
  }
  return undefined;
}

function filterProblem(type: string, { code, operator }: Filter): string | undefined {
  if (code.startsWith('_has:') || code.includes('.')) {
    return `"${code}" is chained, which Medplum's matcher never matches`;
  }
  const param = getSearchParameter(type, code);
  if (!param) {
    return `"${code}" is not one of Medplum's own search parameters for ${type}, the only ones its matcher reads`;
  }
  if (operator === 'missing' || operator === 'present') return undefined;
  const operators = MATCHED[param.type];
  if (!operators) {
    return `"${code}" is a ${param.type} parameter, which Medplum's matcher never matches`;
  }
  if (!operators.includes(operator)) {
    return `Medplum's matcher does not apply "${operator}" to "${code}", a ${param.type} parameter`;
  }
  return undefined;
}

// Medplum checks a Bot's cronString with cron-validator's isValidCron and its
// default options: five fields, numbers only, no names, `?`, `L` or `#`.
const CRON_RANGES = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 6],
] as const;

/** Whether Medplum runs this schedule; it ignores one it finds invalid. */
export function isValidCron(cron: string): boolean {
  const fields = cron.trim().split(/\s+/);
  return (
    fields.length === 5 &&
    fields.every((field, i) => {
      const [min, max] = CRON_RANGES[i] as readonly [number, number];
      return /^[\d,/*-]+$/.test(field) && field.split(',').every((p) => isCronPart(p, min, max));
    })
  );
}

function isCronPart(part: string, min: number, max: number): boolean {
  const [range = '', step, ...rest] = part.split('/');
  if (rest.length > 0 || part.endsWith('/')) return false;
  if (step !== undefined && !(/^\d+$/.test(step) && Number(step) > 0)) return false;
  if (range === '*') return true;
  const sides = range.split('-').map((side) => (/^\d+$/.test(side) ? Number(side) : Number.NaN));
  const [low = Number.NaN, high = low] = sides;
  return sides.length <= 2 && low <= high && low >= min && high <= max;
}

/**
 * Each bot's bundle: it exists and, for vmcontext, is CommonJS that assigns
 * `exports.handler`. Checked before `push` writes anything rather than when
 * the config loads, since a project builds its bots after `generate`.
 */
export function checkBotFiles(bots: Record<string, BotConfig> = {}): ConfigError[] {
  return Object.entries(bots).flatMap(([key, bot]): ConfigError[] => {
    const path = `bots.${key}.file`;
    const problem = !existsSync(bot.file)
      ? `names ${bot.file}, which does not exist: build the bot first`
      : bot.runtime === 'vmcontext'
        ? vmcontextProblem(bot.file)
        : undefined;
    return problem ? [{ code: 'invalid-bot', path, message: `"${path}" ${problem}.` }] : [];
  });
}

// vmcontext evaluates the file as a script inside an async function, with its
// own `exports` and `module`, then calls `exports.handler` (`bots/vmcontext.ts`).
function vmcontextProblem(file: string): string | undefined {
  const notCommonJs = 'is not CommonJS, which vmcontext runs';
  if (file.endsWith('.mjs')) return `${notCommonJs}: .mjs is an ES module`;
  const code = readFileSync(file, 'utf8');
  const reason = parseError(
    () => new Script(`(async () => { const exports = {}; const module = { exports };\n${code}\n})`),
  );
  if (reason) return `${notCommonJs} ${reason}`;
  if (!/\bexports\.handler\s*=|Object\.assign\(\s*exports\s*,/.test(code)) {
    return "never assigns exports.handler, which vmcontext calls; esbuild's CommonJS replaces module.exports, so add the footer Object.assign(exports, module.exports)";
  }
  return undefined;
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

/** A bot or Subscription a push to one environment leaves out, and where it does go. */
export interface ScopedOut {
  kind: 'Bot' | 'Subscription' | 'Operation' | 'Secret';
  key: string;
  environments: string[];
}

/**
 * The config as one environment sees it: without the bots, Subscriptions and
 * secrets scoped to others. A Subscription with no scope of its own takes its bot's.
 */
export function scopeConfig(
  config: PlumbConfig,
  environment: string,
): { config: PlumbConfig; out: ScopedOut[] } {
  const out: ScopedOut[] = [];
  const keep = <T>(
    kind: 'Bot' | 'Subscription' | 'Secret',
    record: Record<string, T> | undefined,
    scope: (entry: T) => string[] | undefined,
  ) => {
    if (!record) return undefined;
    return Object.fromEntries(
      Object.entries(record).filter(([key, entry]) => {
        const environments = scope(entry);
        if (!environments || environments.includes(environment)) return true;
        out.push({ kind, key, environments });
        return false;
      }),
    );
  };
  const bots = keep('Bot', config.bots, (bot) => bot.environments);
  const subscriptions = keep(
    'Subscription',
    config.subscriptions,
    (s) => s.environments ?? (s.bot ? config.bots?.[s.bot]?.environments : undefined),
  );
  const secrets = keep('Secret', config.project?.secrets, (s) =>
    s === true ? undefined : s.environments,
  );
  return {
    config: {
      ...config,
      ...(bots ? { bots } : {}),
      ...(subscriptions ? { subscriptions } : {}),
      ...(secrets ? { project: { ...config.project, secrets } } : {}),
    },
    out,
  };
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
      ...(environment.synthetic ? { synthetic: true } : {}),
    },
  };
}

/** A list of paths or globs, resolved against the config's folder, when the config has it. */
function resolveList(base: string, config: PlumbConfig, key: 'content' | 'operations') {
  const paths = config[key];
  return paths ? { [key]: paths.map((p) => resolve(base, p)) } : {};
}

function resolveTest(base: string, test: TestConfig): TestConfig {
  const bots = Object.entries(test.bots ?? {}).map(([key, bot]) => [
    key,
    { file: resolve(base, bot.file) },
  ]);
  return {
    ...test,
    ...(test.seed ? { seed: test.seed.map((p) => resolve(base, p)) } : {}),
    ...(test.bots ? { bots: Object.fromEntries(bots) } : {}),
  };
}

function resolveBots(base: string, bots: PlumbConfig['bots']): Pick<PlumbConfig, 'bots'> {
  if (!bots) return {};
  const entries = Object.entries(bots).map(([key, bot]) => [
    key,
    { ...bot, file: resolve(base, bot.file) },
  ]);
  return { bots: Object.fromEntries(entries) };
}

function resolveCheck(base: string, check: CheckConfig): ResolvedCheckConfig {
  return {
    tsconfig: [check.tsconfig].flat().map((path) => resolve(base, path)),
    ...(check.baseline ? { baseline: resolve(base, check.baseline) } : {}),
    ignore: check.ignore ?? [],
  };
}
