// Run the Python data pipeline with the project's virtual environment (.venv).
//
//   node scripts/py.mjs setup              create .venv and install requirements.txt
//   node scripts/py.mjs -m pipeline.fetch  run a module with the venv's Python
//
// npm scripts call this so `npm run data` works the same on Windows, macOS and Linux.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const win = process.platform === 'win32';
const venvPython = path.join('.venv', win ? 'Scripts' : 'bin', win ? 'python.exe' : 'python');
const run = (cmd, args) => spawnSync(cmd, args, { stdio: 'inherit' }).status ?? 1;

/** A system Python 3.10+ to create the venv with. On Windows `python` may be the Store stub, so try `py` first. */
function systemPython() {
  const candidates = win ? [['py', ['-3']], ['python', []]] : [['python3', []], ['python', []]];
  for (const [cmd, pre] of candidates) {
    const r = spawnSync(cmd, [...pre, '--version'], { encoding: 'utf8' });
    if (r.status === 0 && /Python 3\.(1\d|[2-9]\d)/.test(`${r.stdout}${r.stderr}`)) return [cmd, pre];
  }
  return null;
}

const args = process.argv.slice(2);
if (args[0] === 'setup' || !existsSync(venvPython)) {
  if (!existsSync(venvPython)) {
    const py = systemPython();
    if (!py) {
      console.error('Python 3.10+ not found. Install it from https://www.python.org/downloads/ and run `npm run setup:py`.');
      process.exit(1);
    }
    console.log(`Creating .venv with ${py[0]} ${py[1].join(' ')}`.trim());
    if (run(py[0], [...py[1], '-m', 'venv', '.venv']) !== 0) process.exit(1);
  }
  if (run(venvPython, ['-m', 'pip', 'install', '--quiet', '-r', 'requirements.txt']) !== 0) process.exit(1);
  if (args[0] === 'setup') process.exit(0);
}
process.exit(run(venvPython, args));
