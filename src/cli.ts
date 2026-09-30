// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { run } from './commands.js';

process.exitCode = await run(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  isTTY: process.stderr.isTTY ?? false,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});
