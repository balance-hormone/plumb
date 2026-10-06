// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from 'vitest/config';

// Run by test/server/vitest.test.ts with this folder as its root; *.check.ts
// keeps Plumb's own run from collecting the file.
export default defineConfig({
  test: { include: ['*.check.ts'], globalSetup: ['../../../src/vitest.ts'] },
});
