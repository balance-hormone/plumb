// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0

// A module that names its migration instead of default-exporting it.
export const migration = {
  id: '20261006-named',
  resourceType: 'Patient',
  transform: () => undefined,
};
