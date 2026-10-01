// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import type { BuildOptions } from 'esbuild';

/**
 * How the checker bot is bundled: one CommonJS file with `@medplum/core`
 * inside, never the server's own copy, whose profile index serves real writes.
 * Medplum's vmcontext runtime evaluates it in a bare context, without the
 * WebSocket global that `@medplum/core` reads when it loads; the bot opens no
 * socket, so a stand-in is enough. The runtime calls `exports.handler`, and
 * esbuild's CommonJS replaces `module.exports`, hence the footer, as in
 * Medplum's own bot template.
 */
export const CHECKER_BUILD = {
  entryPoints: [new URL('handler.ts', import.meta.url).pathname],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'es2022',
  banner: {
    js: 'var WebSocket = globalThis.WebSocket ?? { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 };',
  },
  footer: { js: 'Object.assign(exports, module.exports);' },
} satisfies BuildOptions;
