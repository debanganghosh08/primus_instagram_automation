// Clean, then compile. One node script rather than a shell chain, so the npm
// script behaves identically in PowerShell, cmd.exe and any POSIX shell.
import { spawnSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

await rm(path.join(root, 'dist'), { recursive: true, force: true });

const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
const result = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.build.json'], {
  cwd: root,
  stdio: 'inherit',
});

if (result.error) {
  process.stderr.write(`could not run tsc: ${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);
