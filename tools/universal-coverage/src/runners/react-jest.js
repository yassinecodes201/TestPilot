// React's source repository deliberately rejects invoking Jest directly.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function invoke(args, capture = false) {
  const result = spawnSync(process.execPath, [
    'scripts/jest/jest-cli.js', '--ci', '--sourceMaps', '--runInBand', ...args,
  ], {
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`React test runner failed (${result.status ?? result.signal})`);
  return result.stdout;
}

try {
  const [mode, test, coverage] = process.argv.slice(2);
  if (mode === 'list') {
    const tests = JSON.parse(invoke(['--listTests', '--json'], true));
    if (!Array.isArray(tests) || tests.some(test => typeof test !== 'string')) {
      throw new Error('React test listing must be a JSON array of file paths');
    }
    for (const file of tests) {
      console.log(path.relative(process.cwd(), path.resolve(file)).split(path.sep).join('/'));
    }
  } else if (mode === 'run' && test && coverage) {
    const destination = path.resolve(coverage);
    const directory = path.dirname(destination);
    const report = path.join(directory, 'coverage-final.json');
    fs.mkdirSync(directory, { recursive: true });
    // Remove previous output so a successful process cannot reuse stale coverage.
    fs.rmSync(report, { force: true });
    if (report !== destination) fs.rmSync(destination, { force: true });
    invoke([
      '--watch=false', '--coverage', '--coverageProvider=babel',
      '--coverageReporters=json', `--coverageDirectory=${directory}`,
      '--runTestsByPath', test,
    ]);
    if (!fs.existsSync(report)) throw new Error('React tests produced no coverage-final.json');
    if (report !== destination) fs.renameSync(report, destination);
  } else {
    throw new Error('Usage: react-jest.js list | run <test-file> <coverage-json>');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
