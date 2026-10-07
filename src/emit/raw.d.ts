// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A file's text, inlined when the module is built: by the raw plugin in
 * scripts/build.mjs, on esbuild's text loader, and by Vite under Vitest.
 */
declare module '*?raw' {
  const text: string;
  export default text;
}
