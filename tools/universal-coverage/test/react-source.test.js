const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { discoverTestSetup } = require('../src/lib/discovery');
const { parseC8 } = require('../src/adapters/c8');

function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'testpilot-react-'));
  t.after(() => {
    assert.ok(path.resolve(cwd).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(cwd, 'scripts/jest'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
    scripts: { test: 'node ./scripts/jest/jest-cli.js' },
    devDependencies: { jest: '^29.4.2' },
    jest: { testRegex: '/scripts/jest/dont-run-jest-directly.js$' },
  }));
  fs.writeFileSync(path.join(cwd, 'scripts/jest/config.source.js'), '');
  fs.writeFileSync(path.join(cwd, 'scripts/jest/jest-cli.js'), `
    const fs = require('fs');
    const path = require('path');
    const args = process.argv.slice(2);
    fs.writeFileSync('args.json', JSON.stringify(args));
    if (process.env.FAKE_FAIL) process.exit(1);
    if (args.includes('--listTests')) {
      console.log(JSON.stringify([path.resolve('packages/react/__tests__/component test.js')]));
    } else if (!process.env.FAKE_NO_COVERAGE) {
      const dir = args.find(a => a.startsWith('--coverageDirectory=')).split('=').slice(1).join('=');
      fs.writeFileSync(path.join(dir, 'coverage-final.json'), JSON.stringify({
        'packages/react/src/component.js': {
          statementMap: { 0: { start: { line: 7 }, end: { line: 8 } } }, s: { 0: 1 }
        }
      }));
    }
  `);
  return cwd;
}

function run(cwd, args, env = {}) {
  return spawnSync(process.execPath, [path.resolve(__dirname, '../src/runners/react-jest.js'), ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, ...env },
  });
}

test('React source adapter outranks generic Jest, without claiming ordinary Jest repos', t => {
  const cwd = fixture(t);
  assert.equal(discoverTestSetup({ cwd, probe: false }).adapter, 'react-source-jest');
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ devDependencies: { jest: '*' } }));
  assert.equal(discoverTestSetup({ cwd, probe: false }).adapter, 'jest');
});

test('listing uses the wrapper and emits only portable test paths', t => {
  const cwd = fixture(t);
  const result = run(cwd, ['list']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'packages/react/__tests__/component test.js');
  const args = JSON.parse(fs.readFileSync(path.join(cwd, 'args.json')));
  assert.ok(args.includes('--ci'));
  assert.ok(args.includes('--json'));
});

test('runner preserves exact paths, enables source maps and produces compatible coverage', t => {
  const cwd = fixture(t);
  const coverage = 'coverage/worker-2/custom.json';
  const file = 'packages/react/__tests__/component test.js';
  const result = run(cwd, ['run', file, coverage]);
  assert.equal(result.status, 0, result.stderr);
  const args = JSON.parse(fs.readFileSync(path.join(cwd, 'args.json')));
  assert.equal(args[args.indexOf('--runTestsByPath') + 1], file);
  assert.ok(args.includes('--sourceMaps'));
  assert.ok(args.includes('--coverageProvider=babel'));
  assert.deepEqual([...parseC8(path.join(cwd, coverage)).get('packages/react/src/component.js')], [7, 8]);
});

test('failed tests and missing fresh coverage fail the adapter', t => {
  const cwd = fixture(t);
  assert.notEqual(run(cwd, ['list'], { FAKE_FAIL: '1' }).status, 0);
  const coverage = 'coverage/coverage-final.json';
  assert.equal(run(cwd, ['run', 'test.js', coverage]).status, 0);
  const result = run(cwd, ['run', 'test.js', coverage], { FAKE_NO_COVERAGE: '1' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /produced no coverage/);
  assert.equal(fs.existsSync(path.join(cwd, coverage)), false);
});
