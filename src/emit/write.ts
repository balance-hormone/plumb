// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { MARKER } from './print.js';

interface WriteIssue {
  code: 'foreign-file';
  message: string;
  file: string;
}

export interface WriteResult {
  ok: boolean;
  written: string[];
  removed: string[];
  errors: WriteIssue[];
}

/**
 * Makes `out` hold exactly `files`. Plumb owns the folder: it removes its own
 * files that are no longer generated, and touches nothing if the folder holds
 * anything it did not write.
 */
export function writeFiles(out: string, files: Map<string, string>): WriteResult {
  const existing = existsSync(out) ? readdirSync(out).sort() : [];
  const ours = (name: string) => {
    const path = join(out, name);
    return statSync(path).isFile() && readFileSync(path, 'utf8').startsWith(MARKER);
  };
  const errors = existing
    .filter((name) => !ours(name))
    .map((file) => ({
      code: 'foreign-file' as const,
      file,
      message: `${join(out, file)} was not written by Plumb. Plumb owns ${out}; move the file elsewhere.`,
    }));
  if (errors.length > 0) return { ok: false, written: [], removed: [], errors };

  mkdirSync(out, { recursive: true });
  const removed = existing.filter((name) => !files.has(name));
  for (const name of removed) rmSync(join(out, name));
  const written: string[] = [];
  for (const [name, text] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const path = join(out, name);
    if (existing.includes(name) && readFileSync(path, 'utf8') === text) continue;
    writeFileSync(path, text);
    written.push(name);
  }
  return { ok: true, written, removed, errors: [] };
}
