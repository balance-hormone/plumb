// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0

// A migration as a project's module declares it. A plain object, since
// defineMigration returns its migration unchanged, so the module loads
// without the generated code.
export default {
  id: '20261006-patient-birthdate',
  resourceType: 'Patient',
  search: { 'birthdate:missing': 'true' },
  transform: (patient: { birthDate?: string }) =>
    patient.birthDate ? undefined : [{ op: 'add', path: '/birthDate', value: '1900-01-01' }],
};
