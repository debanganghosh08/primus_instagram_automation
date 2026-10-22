// Cross-platform `rm -rf dist`. Used by `npm run clean` and `npm run build`
// so the scripts work identically in PowerShell, cmd.exe and any POSIX shell.
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');

await rm(dist, { recursive: true, force: true });
process.stdout.write(`cleaned ${dist}\n`);
