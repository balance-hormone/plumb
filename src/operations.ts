// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { deepEquals, type MedplumClient } from '@medplum/core';
import { readJson } from '@medplum/definitions';
import type {
  Bundle,
  OperationDefinition,
  OperationDefinitionParameter,
  ResourceType,
} from '@medplum/fhirtypes';
import { type ConfigError, importModules } from './config.js';
import { PLUMB_SYSTEM, type ProjectOptions, tagOf } from './project.js';

const IMPLEMENTATION =
  'https://medplum.com/fhir/StructureDefinition/operationDefinition-implementation';

/** A contract as `defineOperation` makes it, read from a module the config lists. */
export interface Contract {
  code: string;
  level: 'system' | 'type' | 'instance';
  resource?: ResourceType;
  bot: string;
  /** A resource type, a profile URL, or a Standard Schema value for JSON. */
  input: unknown;
  output: unknown;
  /** The module and export it came from, for errors. */
  from: string;
}

const LEVELS = ['system', 'type', 'instance'];

const isContract = (value: unknown): value is Omit<Contract, 'from'> => {
  const v = value as Partial<Contract> | null;
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof v.code === 'string' &&
    LEVELS.includes(v.level as string) &&
    typeof v.bot === 'string' &&
    'input' in v &&
    'output' in v
  );
};

/**
 * Imports each module `operations` names, absolute paths or globs, as the
 * config is imported, and collects every export `defineOperation` made.
 */
export async function loadOperations(
  paths: string[] = [],
): Promise<{ ok: true; contracts: Contract[] } | { ok: false; errors: ConfigError[] }> {
  const imported = await importModules(paths, 'operations', 'invalid-operation');
  if (!imported.ok) return imported;
  return {
    ok: true,
    contracts: imported.modules.flatMap(({ file, module }) =>
      Object.entries(module)
        .filter(([, value]) => isContract(value))
        .map(([name, value]) => ({
          ...(value as Omit<Contract, 'from'>),
          from: `${file}#${name}`,
        })),
    ),
  };
}

let builtIn: Set<string> | undefined;

/** The codes of the OperationDefinitions @medplum/definitions ships: base R4's and a few of Medplum's. */
function builtInCodes(): Set<string> {
  builtIn ??= new Set(
    // The bundles that hold them; @medplum/definitions 5.1.0 does not list its files.
    ['fhir/r4/profiles-resources.json', 'fhir/r4/profiles-medplum.json'].flatMap((file) =>
      ((readJson(file) as Bundle).entry ?? [])
        .map((e) => e.resource)
        .filter((r): r is OperationDefinition => r?.resourceType === 'OperationDefinition')
        .map((r) => r.code),
    ),
  );
  return builtIn;
}

/**
 * The contracts against the config and the selected profiles: a code used
 * twice or one Medplum already has, a bot `bots` lacks, a profile side not
 * selected, a type or instance operation without its resource.
 */
export function checkOperations(
  contracts: Contract[],
  bots: Record<string, unknown>,
  profiles: string[],
): ConfigError[] {
  const seen = new Map<string, string>();
  return contracts.flatMap((contract): ConfigError[] => {
    const invalid = (message: string): ConfigError => ({
      code: 'invalid-operation',
      path: 'operations',
      message: `${contract.from} ($${contract.code}) ${message}.`,
    });
    const errors: ConfigError[] = [];
    const other = seen.get(contract.code);
    if (other) errors.push(invalid(`has the code ${other} has too`));
    seen.set(contract.code, contract.from);
    if (builtInCodes().has(contract.code)) {
      errors.push(
        invalid('has the code of an operation Medplum already has, which would run instead'),
      );
    }
    if (!Object.hasOwn(bots, contract.bot)) {
      errors.push(invalid(`names the bot "${contract.bot}", which is not a key in bots`));
    }
    if (contract.level !== 'system' && !contract.resource) {
      errors.push(invalid(`is a ${contract.level} operation without a resource`));
    }
    for (const side of [contract.input, contract.output]) {
      if (typeof side === 'string' && side.includes(':') && !profiles.includes(side)) {
        errors.push(invalid(`names the profile ${side}, which is not selected`));
      }
    }
    return errors;
  });
}

/** One write `push` plans for an operation: `+` create, `~` update, `-` delete. */
export type OperationChange =
  | {
      kind: '+' | '~';
      code: string;
      id?: string;
      fields: string[];
      definition: OperationDefinition;
      /** The bot that implements it, by key, when its id is not known until the bots step writes. */
      bot?: string;
    }
  | { kind: '-'; code: string; id: string; kept?: true };

export interface OperationPlan {
  changes: OperationChange[];
  /** Why nothing in the operations step can be applied. */
  blocked: { code: string; message: string }[];
}

/** The fields of an OperationDefinition a contract writes. */
const MANAGED = [
  'name',
  'status',
  'kind',
  'code',
  'system',
  'type',
  'instance',
  'resource',
  'parameter',
  'extension',
] as const;

/**
 * The OperationDefinition a contract becomes: its code, level and resource,
 * its `return` or `result` out parameter, and the bot that implements it.
 * Medplum does not check input against it, so it describes the output only.
 */
export function operationDefinition(
  contract: Contract,
  botId: string | undefined,
  typeOf: (profile: string) => string | undefined,
): OperationDefinition {
  const json = typeof contract.output !== 'string';
  const output = contract.output as string;
  const type = json ? 'string' : output.includes(':') ? typeOf(output) : output;
  return {
    resourceType: 'OperationDefinition',
    name: contract.code,
    status: 'active',
    kind: 'operation',
    code: contract.code,
    system: contract.level === 'system',
    type: contract.level === 'type',
    instance: contract.level === 'instance',
    ...(contract.resource ? { resource: [contract.resource] } : {}),
    parameter: [
      {
        name: json ? 'result' : 'return',
        use: 'out',
        min: 1,
        max: '1',
        type: type as OperationDefinitionParameter['type'],
        ...(!json && output.includes(':') ? { targetProfile: [output] } : {}),
      },
    ],
    ...(botId
      ? { extension: [{ url: IMPLEMENTATION, valueReference: { reference: `Bot/${botId}` } }] }
      : {}),
    meta: { tag: [{ system: PLUMB_SYSTEM, code: contract.code }] },
  };
}

/**
 * Plans the operations against what the project holds: each found by Plumb's
 * tag with its code. An untagged OperationDefinition with a contract's code,
 * here or in a linked project, stops the step: Medplum would pick either.
 */
export async function planOperations(
  medplum: MedplumClient,
  contracts: Contract[],
  typeOf: (profile: string) => string | undefined,
  options: ProjectOptions = {},
): Promise<OperationPlan> {
  const project = medplum.getProject()?.id;
  const visible = await medplum.searchResources('OperationDefinition', { _count: '1000' });
  const bots = (
    await medplum.searchResources('Bot', { identifier: `${PLUMB_SYSTEM}|`, _count: '1000' })
  ).filter((b) => b.meta?.project === project);
  const botIds = Object.fromEntries(
    bots.map((b) => [b.identifier?.find((i) => i.system === PLUMB_SYSTEM)?.value, b.id as string]),
  );
  return planHeldOperations(
    contracts,
    visible.filter((d) => d.meta?.project === project && tagOf(d) !== undefined),
    visible.filter((d) => tagOf(d) === undefined),
    botIds,
    typeOf,
    options,
  );
}

/** The plan for the OperationDefinitions a project holds, and those it can see untagged. */
export function planHeldOperations(
  contracts: Contract[],
  tagged: OperationDefinition[],
  untagged: OperationDefinition[],
  botIds: Record<string, string>,
  typeOf: (profile: string) => string | undefined,
  options: ProjectOptions = {},
): OperationPlan {
  const plan: OperationPlan = { changes: [], blocked: [] };
  const byCode = Map.groupBy(tagged, (d) => tagOf(d) as string);
  for (const contract of contracts) {
    const planned = planContract(
      contract,
      byCode.get(contract.code) ?? [],
      untagged,
      botIds,
      typeOf,
    );
    if (planned && 'message' in planned) plan.blocked.push(planned);
    else if (planned) plan.changes.push(planned);
  }
  const codes = new Set(contracts.map((c) => c.code));
  // Medplum ignores an OperationDefinition's status, so a removed one is deleted, not retired.
  const kept = options.prune ? {} : { kept: true as const };
  for (const [code, found] of byCode) {
    if (codes.has(code)) continue;
    for (const d of found) plan.changes.push({ kind: '-', code, id: d.id as string, ...kept });
  }
  return plan;
}

/** One contract's change, nothing when it is held as declared, or why it is blocked. */
function planContract(
  contract: Contract,
  tagged: OperationDefinition[],
  untagged: OperationDefinition[],
  botIds: Record<string, string>,
  typeOf: (profile: string) => string | undefined,
): OperationChange | OperationPlan['blocked'][number] | undefined {
  const shadow = untagged.find((d) => d.code === contract.code);
  if (shadow) {
    return {
      code: 'shadowed-operation',
      message: `OperationDefinition/${shadow.id} has the code ${contract.code} without Plumb's tag, here or in a linked project: Medplum would run either. Delete it, then push again.`,
    };
  }
  if (tagged.length > 1) {
    return {
      code: 'shadowed-operation',
      message: `${tagged.length} OperationDefinitions carry the tag of ${contract.code}; delete all but one, then push again.`,
    };
  }
  const botId = botIds[contract.bot];
  const desired = operationDefinition(contract, botId, typeOf);
  const bot = botId ? {} : { bot: contract.bot };
  const [current] = tagged;
  if (!current) return { kind: '+', code: contract.code, fields: [], definition: desired, ...bot };
  const fields = MANAGED.filter((f) => !deepEquals(desired[f], current[f]));
  if (fields.length === 0) return undefined;
  return {
    kind: '~',
    code: contract.code,
    id: current.id as string,
    fields: [...fields],
    definition: { ...current, ...desired, id: current.id },
    ...bot,
  };
}

/** Writes the plan in order; a bot this push created is resolved by its identifier. */
export async function applyOperations(
  plan: OperationPlan,
  medplum: MedplumClient,
): Promise<number> {
  let written = 0;
  for (const change of plan.changes) {
    if (change.kind === '-') {
      if (change.kept) continue;
      await medplum.deleteResource('OperationDefinition', change.id);
    } else {
      const definition = await withBot(medplum, change);
      if (change.kind === '+') await medplum.createResource(definition);
      else await medplum.updateResource(definition);
    }
    written++;
  }
  return written;
}

/** The definition, naming the bot this push created by its id. */
async function withBot(
  medplum: MedplumClient,
  change: Extract<OperationChange, { kind: '+' | '~' }>,
): Promise<OperationDefinition> {
  if (!change.bot) return change.definition;
  const bot = await medplum.searchOne('Bot', { identifier: `${PLUMB_SYSTEM}|${change.bot}` });
  if (!bot) throw new Error(`Bot ${change.bot} is not in the project.`);
  const valueReference = { reference: `Bot/${bot.id}` };
  return { ...change.definition, extension: [{ url: IMPLEMENTATION, valueReference }] };
}

/** One change as the plan prints it. */
export function describeOperation(change: OperationChange): string {
  const line = `${change.kind} OperationDefinition  $${change.code}`;
  if (change.kind === '-')
    return change.kept ? `${line} (kept: pass --prune to delete)` : `${line} (delete)`;
  if (change.kind === '+') {
    const bot = change.bot
      ? `Bot ${change.bot}`
      : change.definition.extension?.[0]?.valueReference?.reference;
    return `${line} → ${bot}`;
  }
  return `${line} (${change.fields.join(', ')})`;
}

/** The step's line: what it will write. */
export function operationsSummary(plan: OperationPlan): string {
  if (plan.blocked.length > 0) return 'refusing: see below';
  const count = (kind: OperationChange['kind']) =>
    plan.changes.filter((c) => c.kind === kind && !('kept' in c && c.kept)).length;
  return `plan: ${count('+')} to create, ${count('~')} to update, ${count('-')} to delete`;
}
