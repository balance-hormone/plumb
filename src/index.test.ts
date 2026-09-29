// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from 'vitest';
import { PACKAGE } from './index.js';

describe('plumb', () => {
  test('exports its package name', () => {
    expect(PACKAGE).toBe('plumb');
  });
});
