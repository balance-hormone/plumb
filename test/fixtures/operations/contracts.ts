// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0

// Two operation contracts, as a project's module lists them: one with JSON
// sides, one with FHIR sides. Plain objects, since defineOperation returns its
// contract unchanged, so the module loads without the generated code.

/** A Standard Schema for `{ text: string }`, as Zod or Valibot would hand over. */
export const message = {
  '~standard': {
    version: 1 as const,
    vendor: 'plumb-test',
    validate: (value: unknown) => {
      const text = (value as { text?: unknown } | null)?.text;
      return typeof text === 'string'
        ? { value: { text } }
        : { issues: [{ message: 'Required', path: ['text'] }] };
    },
  },
};

export const shout = {
  code: 'plumb-shout',
  level: 'system' as const,
  bot: 'shouter',
  input: message,
  output: message,
};

export const activate = {
  code: 'plumb-activate',
  level: 'type' as const,
  resource: 'Patient' as const,
  bot: 'activator',
  input: 'Patient' as const,
  output: 'Patient' as const,
};
