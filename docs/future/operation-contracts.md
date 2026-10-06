# Idea: Operation Contracts

**Status: picked up** by [design 10](../design/10-behaviour.md), which
replaces Zod with Standard Schema or FHIR types on each side. This note keeps
the original sketch.

## Problem

A caller invokes a bot-backed FHIR operation by string name and casts the
response. The bot and the caller deploy separately and can disagree without
anyone noticing.

## Sketch

```ts
export const sendMessage = defineOperation({
  code: 'send-message',
  resourceType: 'Communication',
  level: 'type',
  input: messageDraftSchema,
  output: sentMessageSchema,
});
```

- **Callers** use `callOperation(medplum, contract, input)`, which infers the
  output type and parses the response. **Handlers** use
  `handleOperation(contract, fn)`, which parses the input and type-checks the
  return. A server change breaks the caller at compile time (tRPC's idea), and
  version skew fails loudly at runtime.
- **The OperationDefinition is generated from the contract,** with the
  `operationDefinition-implementation` extension referencing the Bot, so the
  FHIR-facing signature cannot drift from the code.
- Contracts import only Zod and FHIR types, so they stay small in a bot bundle.

## What Medplum does with custom operations

From Medplum's source:

- **It finds the operation by `code` alone,** ignoring `resource`, `system` and
  `type`, and runs it only when no built-in operation matches. Contract codes
  must be unique in the project and must not collide with a built-in.
- **The bot receives the raw POST body** (or, for `instance` operations, the
  stored resource). There is no `Parameters` unwrapping and no validation
  against the OperationDefinition, so the handler's parse is the only input
  validation.
- **Output:** a returned `Parameters` passes through; anything else is mapped
  to the `out` parameters, and a single `return` parameter comes back bare.

## Overlap with Medplum's marketplace

The marketplace manifest's operation entry (`code`, `parameter`,
`delegatesTo`, and the wire shapes it accepts: `parameters` or `plain-json`)
covers the same ground. If this tool is picked up, it should emit marketplace
operation entries from a contract rather than compete with them.

## User stories carried over

1. One contract per bot-backed operation: name, level, input and output in one
   file.
2. Caller and handler both typed from the contract and both parsing at runtime.
3. The OperationDefinition generated from the contract.

## Ties to other pieces

- Needs no profiles; uses Plumb's generated types when present.
- [Project config as code](project-config-as-code.md) would load the generated
  OperationDefinitions.

## Research

- [Medplum server behaviour](../research/medplum-server-behaviour.md): custom
  FHIR operations, the marketplace.
