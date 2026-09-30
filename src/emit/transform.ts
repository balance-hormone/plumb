// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0

// Transform: every FHIR rule lives here. A pure function from parsed profiles
// to a small tree of TypeScript types; printing is print.ts's job.
import {
  getDataType,
  type InternalSchemaElement,
  type InternalTypeSchema,
  type SliceDefinition,
  type SlicingRules,
  tryGetProfile,
} from '@medplum/core';
import type { StructureDefinition } from '@medplum/fhirtypes';
import type { LoadProfilesResult } from '../loader.js';
import { type Code, expandValueSet } from './valuesets.js';

export type TypeExpr =
  | { kind: 'ref'; name: string; args?: TypeExpr[] }
  | { kind: 'primitive'; name: 'string' | 'number' | 'boolean' }
  /** `NonNullable<Base['key']>`, which keeps Medplum's own type for the field. */
  | { kind: 'index'; base: string; key: string }
  | { kind: 'literal'; value: string | number | boolean }
  | { kind: 'array'; of: TypeExpr }
  | { kind: 'tuple'; of: TypeExpr[] }
  /** Inside a tuple: an optional position, or the rest. */
  | { kind: 'optional'; of: TypeExpr }
  | { kind: 'rest'; of: TypeExpr }
  | { kind: 'union'; of: TypeExpr[] }
  /** An exact object: only these fields. */
  | { kind: 'object'; fields: Field[] }
  /** `Omit<base, omit> & { fields } & (oneOf[0][0] | oneOf[0][1]) & …` */
  | { kind: 'narrow'; base: TypeExpr; omit: string[]; fields: Field[]; oneOf?: Field[][][] }
  | { kind: 'require'; base: TypeExpr; keys: string[] }
  | { kind: 'never' }
  /** `(string & {})`: any other string, with the listed literals still suggested. */
  | { kind: 'otherString' };

export interface Field {
  name: string;
  optional: boolean;
  type: TypeExpr;
  doc?: string;
}

interface TypeDecl {
  name: string;
  type: TypeExpr;
}

/** A slice's builder, which fills in its discriminator values, or its reader. */
export interface Helper {
  kind: 'build' | 'get';
  name: string;
  /** The slice's type. */
  shape: string;
  /** The sliced element, and the base type of its entries. */
  element: string;
  item: string;
  slice: string;
  /** The discriminator values an entry of this slice holds. */
  values: Record<string, unknown>;
}

export interface ProfileModel {
  url: string;
  version?: string;
  /** `local`, `base`, or the package as `name@version`. */
  source: string;
  sd: StructureDefinition;
  typeName: string;
  /** The profile's doc comment: its description, and the rules the type cannot check. */
  doc: string[];
  /** The profile's type first, then the backbone elements it narrows and its slices. */
  decls: TypeDecl[];
  helpers: Helper[];
  /** The codes of each required binding on a CodeableConcept, which the type leaves open. */
  constants: { name: string; codes: Code[] }[];
  /** How many slice types the profile has. */
  slices: number;
}

interface TransformIssue {
  code: 'type-name-clash';
  message: string;
  url: string;
}

const NUMBERS = new Set(['integer', 'decimal', 'positiveInt', 'unsignedInt']);
// By default, a value set with more codes than this is typed as its base type, not a union.
const MAX_CODES = 100;
const BASE_URL = 'http://hl7.org/fhir/StructureDefinition/';

const isComplex = (code: string) => /^[A-Z]/.test(code);
const ref = (name: string, args?: TypeExpr[]): TypeExpr =>
  args ? { kind: 'ref', name, args } : { kind: 'ref', name };
const never: TypeExpr = { kind: 'never' };
const literal = (value: string): TypeExpr => ({ kind: 'literal', value });
const literals = (values: string[]): TypeExpr =>
  values.length === 1 ? literal(values[0] as string) : { kind: 'union', of: values.map(literal) };

function primitive(code: string): TypeExpr {
  if (code === 'boolean') return { kind: 'primitive', name: 'boolean' };
  return { kind: 'primitive', name: NUMBERS.has(code) ? 'number' : 'string' };
}

function pascal(text: string): string {
  const name = text
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
  return /^[0-9]/.test(name) ? `P${name}` : name;
}

/** `USCorePatientProfile` becomes `USCorePatient`. */
function profileName(sd: StructureDefinition): string {
  const name = pascal(sd.name ?? sd.url.slice(sd.url.lastIndexOf('/') + 1));
  return name.endsWith('Profile') && name !== 'Profile' ? name.slice(0, -'Profile'.length) : name;
}

/** An exact value, as the literal type of its JSON. */
function literalOf(value: unknown): TypeExpr {
  if (Array.isArray(value)) return { kind: 'tuple', of: value.map(literalOf) };
  if (value !== null && typeof value === 'object') {
    return {
      kind: 'object',
      fields: Object.entries(value).map(([name, v]) => ({
        name,
        optional: false,
        type: literalOf(v),
      })),
    };
  }
  return { kind: 'literal', value: value as string | number | boolean };
}

/**
 * A pattern: its scalar values become literals and the rest stays open. An
 * array in a pattern means "contains", which a type cannot say, so it is left
 * to the doc comment.
 */
function patternOf(value: unknown, code: string | undefined): TypeExpr | undefined {
  if (Array.isArray(value)) return undefined;
  if (value === null || typeof value !== 'object') return literalOf(value);
  if (!code) return undefined;
  const base = getDataType(code).elements;
  const fields: Field[] = [];
  for (const [name, v] of Object.entries(value)) {
    const type = patternOf(v, base[name]?.type[0]?.code);
    if (type) fields.push({ name, optional: false, type });
  }
  if (fields.length === 0) return undefined;
  return { kind: 'narrow', base: ref(code), omit: fields.map((f) => f.name), fields };
}

/** Elements below `key`, keyed by the rest of their path. */
function childrenOf(elements: Record<string, InternalSchemaElement>, key: string) {
  const prefix = `${key}.`;
  return Object.fromEntries(
    Object.entries(elements)
      .filter(([k]) => k.startsWith(prefix))
      .map(([k, e]) => [k.slice(prefix.length), e]),
  );
}

const firstSentence = (text: string | undefined) => text?.split(/(?<=\.)\s/)[0]?.trim();

/** Turns one parsed profile into its type declarations. */
class ProfileTransform {
  readonly notes: string[] = [];
  readonly warnings: string[] = [];
  readonly helpers: Helper[] = [];
  readonly constants: { name: string; codes: Code[] }[] = [];
  private inner = new Map<string, string>();
  private readonly sliceDecls: TypeDecl[] = [];
  private readonly usedNames = new Set<string>();
  /** The slices enclosing the current one, so a sub-extension's type is named after its extension. */
  private readonly prefix: string[] = [];

  private readonly schema: InternalTypeSchema;
  private readonly typeName: string;
  private readonly targetType: (url: string) => string | undefined;
  private readonly expand: (url: string) => Code[] | undefined;
  private readonly maxCodes: number;

  constructor(
    schema: InternalTypeSchema,
    typeName: string,
    targetType: (url: string) => string | undefined,
    expand: (url: string) => Code[] | undefined,
    maxCodes: number,
  ) {
    this.schema = schema;
    this.typeName = typeName;
    this.targetType = targetType;
    this.expand = expand;
    this.maxCodes = maxCodes;
  }

  get sliceCount(): number {
    return this.sliceDecls.length;
  }

  decls(): TypeDecl[] {
    // A backbone element is narrowed if its own elements change, or it refers
    // to one that is, which is how Questionnaire.item.item stays narrowed.
    const types = this.schema.innerTypes;
    let grew = true;
    while (grew) {
      grew = false;
      for (const t of types) {
        if (this.inner.has(t.name)) continue;
        if (this.node(t.name, t.elements, getDataType(t.name).elements, t.path).kind !== 'ref') {
          this.inner.set(t.name, this.innerName(t.name));
          grew = true;
        }
      }
    }
    // The final pass records notes, slice types and helpers once.
    this.notes.length = 0;
    this.warnings.length = 0;
    this.helpers.length = 0;
    this.constants.length = 0;
    this.sliceDecls.length = 0;
    this.usedNames.clear();
    const root = getDataType(this.schema.type).elements;
    const decls = [
      {
        name: this.typeName,
        type: this.node(this.schema.type, this.schema.elements, root, this.schema.type),
      },
    ];
    for (const t of types) {
      const name = this.inner.get(t.name);
      if (name)
        decls.push({
          name,
          type: this.node(t.name, t.elements, getDataType(t.name).elements, t.path),
        });
    }
    return [...decls, ...this.sliceDecls];
  }

  private innerName(name: string): string {
    const type = this.schema.type;
    return this.typeName + (name.startsWith(type) ? name.slice(type.length) : name);
  }

  /** A type narrowed from `baseName` by the elements that differ from its base. */
  private node(
    baseName: string,
    elements: Record<string, InternalSchemaElement>,
    baseElements: Record<string, InternalSchemaElement>,
    path: string,
  ): TypeExpr {
    const fields: Field[] = [];
    const omit: string[] = [];
    const required: string[] = [];
    const oneOf: Field[][][] = [];
    for (const [key, e] of Object.entries(elements)) {
      if (key.includes('.')) continue;
      const be = baseElements[key];
      const children = childrenOf(elements, key);
      if (key.endsWith('[x]')) this.choice(key, e, be, children, { fields, omit, oneOf });
      else this.member(key, e, be, children, `${path}.${key}`, { fields, omit, required });
    }
    if (fields.length === 0 && oneOf.length === 0 && omit.length === 0) {
      return required.length > 0
        ? { kind: 'require', base: ref(baseName), keys: required }
        : ref(baseName);
    }
    for (const key of required) {
      omit.push(key);
      fields.push({
        name: key,
        optional: false,
        type: this.requiredType(baseName, key, elements[key], baseElements[key]),
      });
    }
    const order = Object.keys(elements);
    fields.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
    return {
      kind: 'narrow',
      base: ref(baseName),
      omit,
      fields,
      ...(oneOf.length > 0 ? { oneOf } : {}),
    };
  }

  /** One non-choice element: prohibited, retyped, only newly required, or unchanged. */
  private member(
    key: string,
    e: InternalSchemaElement,
    be: InternalSchemaElement | undefined,
    children: Record<string, InternalSchemaElement>,
    path: string,
    into: { fields: Field[]; omit: string[]; required: string[] },
  ): void {
    this.note(path, e, be);
    if (e.max === 0 && be?.max !== 0) {
      into.omit.push(key);
      into.fields.push({ name: key, optional: true, type: never });
      return;
    }
    const changed = this.elementType(e, be, children, path);
    const sliced = e.slicing?.slices.length
      ? this.slices(key, e, path, changed ?? this.baseItem(e))
      : undefined;
    if (sliced) {
      into.omit.push(key);
      into.fields.push({ name: key, optional: e.min === 0, type: sliced });
      return;
    }
    if (changed) {
      const isArray = be?.isArray ?? e.isArray ?? false;
      into.omit.push(key);
      into.fields.push({
        name: key,
        optional: e.min === 0,
        type: isArray ? { kind: 'array', of: changed } : changed,
        doc: firstSentence(e.description),
      });
    } else if (e.min > 0 && (be?.min ?? 0) === 0) {
      into.required.push(key);
    }
  }

  /** An element's entry type when the profile leaves it alone. */
  private baseItem(e: InternalSchemaElement): TypeExpr {
    const code = e.type[0]?.code ?? 'Element';
    const innerName = this.inner.get(code);
    if (innerName) return ref(innerName);
    return isComplex(code) ? ref(code) : primitive(code);
  }

  /**
   * Declares a type per slice, with helpers where the discriminator values are
   * known, and returns the element's type when the slicing changes it: a union
   * of the slice types when closed, a tuple when ordered.
   */
  private slices(key: string, e: InternalSchemaElement, path: string, item: TypeExpr) {
    const slicing = e.slicing as SlicingRules;
    const code = e.type[0]?.code ?? 'Element';
    const names = slicing.slices.map((slice) => slice.name);
    if (new Set(names).size !== names.length) {
      const message = `${path}: Medplum parses its slicing inconsistently (a slice appears more than once, as it does for slices inside slices), so no slice types are generated for it. Medplum's validator reads the same parse.`;
      this.notes.push(message);
      this.warnings.push(message);
      return undefined;
    }
    const shapes: { slice: SliceDefinition; type: TypeExpr }[] = [];
    for (const slice of slicing.slices) {
      const name = this.uniqueName(`${this.typeName}${this.prefix.join('')}`, key, slice.name);
      this.prefix.push(pascal(slice.name));
      this.sliceDecls.push({ name, type: this.sliceShape(slice, code, `${path}:${slice.name}`) });
      this.prefix.pop();
      shapes.push({ slice, type: ref(name) });
      const max = slice.max === Number.POSITIVE_INFINITY ? '*' : slice.max;
      this.notes.push(`${path}:${slice.name}: ${slice.min}..${max}.`);
      this.addHelpers(slicing, slice, key, code, name);
    }
    if (slicing.ordered) return this.tuple(shapes, slicing, item);
    if (slicing.rule !== 'closed') return undefined;
    const types = shapes.map((s) => s.type);
    return {
      kind: 'array',
      of: types.length === 1 ? (types[0] as TypeExpr) : { kind: 'union', of: types },
    } satisfies TypeExpr;
  }

  /** The slice's name, then with its element's, then numbered, until no other type has it. */
  private uniqueName(stem: string, key: string, slice: string): string {
    const plain = `${stem}${pascal(slice)}`;
    const qualified = `${stem}${pascal(key)}${pascal(slice)}`;
    let name = this.usedNames.has(plain) ? qualified : plain;
    for (let n = 2; this.usedNames.has(name); n++) name = `${qualified}${n}`;
    this.usedNames.add(name);
    return name;
  }

  /** Ordered slicing: each slice in its place, then any other entries when the slicing is open. */
  private tuple(
    shapes: { slice: SliceDefinition; type: TypeExpr }[],
    slicing: SlicingRules,
    item: TypeExpr,
  ): TypeExpr {
    const of: TypeExpr[] = [];
    let optional = false;
    for (const [i, { slice, type }] of shapes.entries()) {
      if (slice.max > 1) {
        // A repeating slice can only be the tuple's rest, so only the last may repeat.
        if (i !== shapes.length - 1 || slicing.rule !== 'closed') {
          return { kind: 'array', of: { kind: 'union', of: [...shapes.map((s) => s.type), item] } };
        }
        of.push({ kind: 'rest', of: type });
        return { kind: 'tuple', of };
      }
      optional ||= slice.min === 0;
      of.push(optional ? { kind: 'optional', of: type } : type);
    }
    if (slicing.rule !== 'closed') of.push({ kind: 'rest', of: item });
    return { kind: 'tuple', of };
  }

  /** A slice narrows its element; an extension slice takes its extension profile's type. */
  private sliceShape(slice: SliceDefinition, code: string, path: string): TypeExpr {
    const profile = code === 'Extension' ? slice.type?.[0]?.profile?.[0] : undefined;
    // A slice may name its extension with a version; Medplum keys profiles by URL alone.
    const schema = profile ? tryGetProfile(profile.split('|')[0] as string) : undefined;
    const elements = schema?.elements ?? slice.elements;
    return this.node(code, elements, getDataType(code).elements, path);
  }

  private addHelpers(
    slicing: SlicingRules,
    slice: SliceDefinition,
    element: string,
    item: string,
    shape: string,
  ): void {
    const values = discriminatorValues(slicing, slice);
    if (!values) return;
    // The slice type's name is unique, so a helper named after it is too.
    const name = shape.slice(this.typeName.length);
    const common = { shape, element, item, slice: slice.name, values };
    // A leading run of capitals lowercases as a run: VSCat gives vsCat, MRN gives mrn.
    const build = name.replace(/^[A-Z]+(?=[A-Z][a-z0-9]|$)|^[A-Z]/, (m) => m.toLowerCase());
    this.helpers.push({ kind: 'build', name: build, ...common });
    this.helpers.push({ kind: 'get', name: `get${name}`, ...common });
  }

  /** A field that only becomes required keeps its base type. */
  private requiredType(
    baseName: string,
    key: string,
    e: InternalSchemaElement | undefined,
    be: InternalSchemaElement | undefined,
  ): TypeExpr {
    const code = e?.type[0]?.code ?? '';
    if (e?.type.length === 1 && isComplex(code) && code !== 'Reference') {
      return (be?.isArray ?? e.isArray) ? { kind: 'array', of: ref(code) } : ref(code);
    }
    return { kind: 'index', base: baseName, key };
  }

  /** The item type of an element whose type the profile changes, or undefined. */
  private elementType(
    e: InternalSchemaElement,
    be: InternalSchemaElement | undefined,
    children: Record<string, InternalSchemaElement>,
    path: string,
  ): TypeExpr | undefined {
    const code = e.type[0]?.code;
    if (e.fixed) return literalOf(e.fixed.value);
    if (e.pattern) {
      const pattern = patternOf(e.pattern.value, code);
      if (pattern) return pattern;
    }
    if (!code) return undefined;
    const bound = this.binding(e, be, code, path);
    if (bound) return bound;
    const innerName = this.inner.get(code);
    if (innerName) return ref(innerName);
    if (code === 'Reference') return this.reference(e, be);
    if (isComplex(code) && Object.keys(children).length > 0) {
      const narrowed = this.node(code, children, getDataType(code).elements, path);
      if (narrowed.kind !== 'ref') return narrowed;
    }
    return undefined;
  }

  /**
   * A binding the profile adds or tightens (decision 3): a literal union on a
   * code or Coding where the value set can be listed offline, suggestions for
   * an extensible code, and exported codes for a CodeableConcept, whose
   * "at least one coding" rule a type cannot say.
   */
  private binding(
    e: InternalSchemaElement,
    be: InternalSchemaElement | undefined,
    code: string,
    path: string,
  ): TypeExpr | undefined {
    const codes = this.boundCodes(e, be, code, path);
    if (!codes) return undefined;
    const required = e.binding?.strength === 'required';
    if (code === 'code') {
      const values = [...new Set(codes.map((c) => c.code))];
      if (required) return literals(values);
      return { kind: 'union', of: [...values.map(literal), { kind: 'otherString' }] };
    }
    if (code === 'Coding' && required) {
      const systems = [...new Set(codes.map((c) => c.system))];
      const branches = systems.map((system): Field[] => [
        { name: 'system', optional: false, type: literal(system) },
        {
          name: 'code',
          optional: false,
          type: literals(codes.filter((c) => c.system === system).map((c) => c.code)),
        },
      ]);
      return {
        kind: 'narrow',
        base: ref('Coding'),
        omit: ['system', 'code'],
        fields: [],
        oneOf: [branches],
      };
    }
    if (code === 'CodeableConcept' && required) {
      const name = `${this.typeName}${pascal(path.slice(path.indexOf('.') + 1))}Codes`;
      if (!this.constants.some((c) => c.name === name)) this.constants.push({ name, codes });
      const url = e.binding?.valueSet?.split('|')[0];
      this.notes.push(`${path} must hold a coding from ${url} (${name}); only a server checks it.`);
    }
    return undefined;
  }

  /**
   * The codes of a binding the profile adds or tightens, when it is typed at
   * all and they can be listed; otherwise the doc comment says why not.
   */
  private boundCodes(
    e: InternalSchemaElement,
    be: InternalSchemaElement | undefined,
    code: string,
    path: string,
  ): Code[] | undefined {
    const binding = e.binding;
    const bare = (url: string | undefined) => url?.split('|')[0];
    if (!binding?.valueSet) return undefined;
    const typed =
      binding.strength === 'required' || (binding.strength === 'extensible' && code === 'code');
    const base = be?.binding;
    const unchanged =
      base && bare(base.valueSet) === bare(binding.valueSet) && base.strength === binding.strength;
    if (!typed || unchanged) return undefined;
    const codes = this.expand(binding.valueSet);
    if (codes && codes.length <= this.maxCodes) return codes;
    const why = codes ? `more than ${this.maxCodes} codes` : 'codes that cannot be listed offline';
    this.notes.push(
      `${path} is bound to ${bare(binding.valueSet)}, which has ${why}; only a server checks it.`,
    );
    return undefined;
  }

  private reference(e: InternalSchemaElement, be: InternalSchemaElement | undefined) {
    const types = (el: InternalSchemaElement | undefined) =>
      [
        ...new Set((el?.type ?? []).flatMap((t) => t.targetProfile ?? []).map(this.targetType)),
      ].sort();
    const targets = types(e);
    const base = types(be);
    if (targets.length === 0 || targets.includes(undefined) || targets.includes('Resource'))
      return undefined;
    if (targets.length === base.length && targets.every((t, i) => t === base[i])) return undefined;
    const refs = (targets as string[]).map((t) => ref(t));
    return ref('Reference', [
      refs.length === 1 ? (refs[0] as TypeExpr) : { kind: 'union', of: refs },
    ]);
  }

  private choice(
    key: string,
    e: InternalSchemaElement,
    be: InternalSchemaElement | undefined,
    children: Record<string, InternalSchemaElement>,
    into: { fields: Field[]; omit: string[]; oneOf: Field[][][] },
  ): void {
    const stem = key.slice(0, -'[x]'.length);
    const prop = (code: string) => stem + code.charAt(0).toUpperCase() + code.slice(1);
    const baseCodes = (be?.type ?? []).map((t) => t.code);
    const codes = e.type.map((t) => t.code);
    if (e.max === 0) {
      for (const code of baseCodes) {
        into.omit.push(prop(code));
        into.fields.push({ name: prop(code), optional: true, type: never });
      }
      return;
    }
    for (const code of baseCodes) if (!codes.includes(code)) into.omit.push(prop(code));
    const item = (code: string): TypeExpr => {
      const narrowed = codes.length === 1 ? this.elementType(e, be, children, key) : undefined;
      return narrowed ?? (isComplex(code) ? ref(code) : primitive(code));
    };
    const single = codes.length === 1 ? (codes[0] as string) : undefined;
    if (e.min > 0 && single) {
      into.omit.push(prop(single));
      into.fields.push({ name: prop(single), optional: false, type: item(single) });
    } else if (e.min > 0) {
      into.omit.push(...codes.map(prop));
      into.oneOf.push(
        codes.map((code) => [
          { name: prop(code), optional: false, type: item(code) },
          ...codes
            .filter((c) => c !== code)
            .map((c) => ({ name: prop(c), optional: true, type: never })),
        ]),
      );
    } else if (single && this.elementType(e, be, children, key)) {
      into.omit.push(prop(single));
      into.fields.push({ name: prop(single), optional: true, type: item(single) });
    }
  }

  /** Rules the types cannot state: array lengths and patterns on arrays. */
  private note(path: string, e: InternalSchemaElement, be: InternalSchemaElement | undefined) {
    const entries = (n: number) => `${n} entr${n === 1 ? 'y' : 'ies'}`;
    const isArray = e.isArray || be?.isArray;
    if (isArray && e.min > 0) this.notes.push(`${path}: at least ${entries(e.min)}.`);
    if (isArray && e.max > 0 && e.max < (be?.max ?? Number.POSITIVE_INFINITY)) {
      this.notes.push(`${path}: at most ${entries(e.max)}.`);
    }
    if (e.pattern && typeof e.pattern.value === 'object') {
      this.notes.push(`${path} must match the pattern ${JSON.stringify(e.pattern.value)}.`);
    }
  }
}

/**
 * The values an entry of a slice holds at each discriminator path, or
 * undefined when a discriminator is not by value or pattern, or has none.
 */
export function discriminatorValues(slicing: SlicingRules, slice: SliceDefinition) {
  const values: Record<string, unknown> = {};
  for (const d of slicing.discriminator) {
    if (d.type !== 'value' && d.type !== 'pattern') return undefined;
    if (d.path === '$this') {
      const whole = wholeValue(slice);
      if (!whole) return undefined;
      Object.assign(values, whole);
      continue;
    }
    const element = slice.elements[d.path];
    // An extension slice names its extension by profile rather than a fixed url.
    const value =
      element?.fixed?.value ??
      element?.pattern?.value ??
      (d.path === 'url' ? slice.type?.[0]?.profile?.[0]?.split('|')[0] : undefined);
    if (value === undefined) return undefined;
    setPath(values, d.path, value, slice);
  }
  return values;
}

/** `$this` discriminates on the whole entry, whose value is the slice's own fixed or pattern object. */
function wholeValue(slice: SliceDefinition): Record<string, unknown> | undefined {
  const whole = slice.fixed?.value ?? slice.pattern?.value;
  if (whole === null || typeof whole !== 'object' || Array.isArray(whole)) return undefined;
  return whole as Record<string, unknown>;
}

/** Sets `value` at a dotted path, where a path through a repeating element holds one entry of it. */
function setPath(
  values: Record<string, unknown>,
  path: string,
  value: unknown,
  slice: SliceDefinition,
) {
  const parts = path.split('.');
  let target = values;
  parts.forEach((part, i) => {
    const repeats = slice.elements[parts.slice(0, i + 1).join('.')]?.isArray;
    if (i === parts.length - 1) {
      target[part] = repeats && !Array.isArray(value) ? [value] : value;
      return;
    }
    target[part] ??= repeats ? [{}] : {};
    const next = target[part];
    target = (Array.isArray(next) ? next[0] : next) as Record<string, unknown>;
  });
}

function invariants(sd: StructureDefinition): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const element of sd.snapshot?.element ?? []) {
    for (const c of element.constraint ?? []) {
      if (c.severity !== 'error' || c.source?.startsWith(BASE_URL) || seen.has(c.key ?? ''))
        continue;
      seen.add(c.key ?? '');
      lines.push(`${c.key}: ${c.human}`);
    }
  }
  return lines;
}

function docFor(sd: StructureDefinition, notes: string[]): string[] {
  const doc = [sd.title ?? sd.name ?? sd.url];
  const description = sd.description?.split(/\n\s*\n/)[0]?.trim();
  if (description) doc.push('', description);
  doc.push('', `Profile: ${sd.url}${sd.version ? `|${sd.version}` : ''}`);
  const rules = [...notes, ...invariants(sd)];
  if (rules.length > 0) {
    doc.push('', 'Not checked by this type; checked by validateProfiled and the server:');
    doc.push(...rules.map((r) => `- ${r}`));
  }
  return doc;
}

/** Turns the loaded profiles into type models, naming each type. */
export function transform(
  loaded: LoadProfilesResult,
  options: { maxCodes?: number } = {},
): {
  models: ProfileModel[];
  errors: TransformIssue[];
  /** What the types leave out because Medplum's parse cannot support it. */
  warnings: string[];
} {
  const targetType = (url: string): string | undefined => {
    const bare = url.split('|')[0] as string;
    const sd = loaded.definitions.get(bare)?.resource;
    if (sd?.resourceType === 'StructureDefinition') return sd.type;
    return bare.startsWith(BASE_URL) ? bare.slice(BASE_URL.length) : undefined;
  };
  // Names come from the profile; profiles that share one are named from their URLs.
  const names = loaded.profiles.map((p) => profileName(p.sd));
  const clashing = new Set(names.filter((n, i) => names.indexOf(n) !== i));
  const final = loaded.profiles.map((p, i) =>
    clashing.has(names[i] as string)
      ? pascal(p.url.slice(p.url.lastIndexOf('/') + 1))
      : (names[i] as string),
  );
  const errors: TransformIssue[] = [];
  final.forEach((name, i) => {
    if (final.indexOf(name) !== i) {
      const url = loaded.profiles[i]?.url as string;
      errors.push({
        code: 'type-name-clash',
        url,
        message: `${url} and another profile both name the type ${name}.`,
      });
    }
  });

  const lookup = (url: string) => loaded.definitions.get(url.split('|')[0] as string)?.resource;
  const expand = (url: string) => expandValueSet(url, lookup);
  const warnings: string[] = [];
  const models = loaded.profiles.map((p, i): ProfileModel => {
    const t = new ProfileTransform(
      p.schema,
      final[i] as string,
      targetType,
      expand,
      options.maxCodes ?? MAX_CODES,
    );
    const decls = t.decls();
    warnings.push(...t.warnings);
    return {
      url: p.url,
      version: p.sd.version,
      source: p.source,
      sd: p.sd,
      typeName: final[i] as string,
      doc: docFor(p.sd, t.notes),
      decls,
      helpers: [...t.helpers],
      constants: [...t.constants],
      slices: t.sliceCount,
    };
  });
  return { models, errors, warnings };
}
