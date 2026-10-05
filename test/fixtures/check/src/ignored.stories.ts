// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import type { MedplumClient } from '@medplum/core';

export const fixture = (medplum: MedplumClient) => medplum.readResource('Patient', '1');
