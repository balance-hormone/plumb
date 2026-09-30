// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface PlumbConfig {
  /** IG packages as `name@version`, with an exact version. */
  igs: string[];
  /** Canonical URLs of the profiles to generate types for. */
  profiles: string[];
  /** A folder of StructureDefinition JSON outside any package. */
  local?: string;
  /** The folder Plumb generates into and owns. */
  out: string;
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
  | 'invalid-profile';

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
const KEYS = new Set(['igs', 'profiles', 'local', 'out']);
// FHIR package names are lowercase dotted segments; versions are exact, never ranges.
const IG = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+@\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/**
 * Loads `plumb.config.ts` from `cwd`, or `configPath` relative to it, with
 * Node's own type stripping. `local` and `out` come back as absolute paths,
 * resolved against the config file's folder.
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
  return {
    ok: true,
    configPath,
    config: {
      ...config,
      out: resolve(base, config.out),
      ...(config.local === undefined ? {} : { local: resolve(base, config.local) }),
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
      (url) => URL.canParse(url) && !url.includes('|'),
      'invalid-profile',
      'an absolute canonical URL without a |version',
    ),
  );
  if (record.local !== undefined && typeof record.local !== 'string') {
    errors.push({ code: 'invalid-type', path: 'local', message: '"local" must be a path.' });
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
