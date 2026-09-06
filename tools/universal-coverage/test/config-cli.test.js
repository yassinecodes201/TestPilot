const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const cliPath = path.resolve(__dirname, '../src/index.js');
const testIds = ['tests/alpha test.rb', 'tests/beta_test.rb'];

function fixture(t, controls = {}, configName = 'testpilot.yml') {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'testpilot-config-cli-'));
  const cwd = path.join(temporaryRoot, 'project with spaces');
  fs.mkdirSync(cwd);
  t.after(() => {
    const resolvedRoot = path.resolve(temporaryRoot);
    const allowedParent = path.resolve(os.tmpdir());
    assert.equal(path.dirname(resolvedRoot), allowedParent);
    assert.ok(path.basename(resolvedRoot).startsWith('testpilot-config-cli-'));
    fs.rmSync(resolvedRoot, { recursive: true, force: true });
  });

  fs.writeFileSync(path.join(cwd, 'controls.json'), JSON.stringify({
    tests: testIds,
    requireSetup: true,
    ...controls,
  }));
  fs.writeFileSync(path.join(cwd, 'fixture runner.cjs'), `
    const fs = require('node:fs');
    const path = require('node:path');
    const [action, ...args] = process.argv.slice(2);
    const controls = JSON.parse(fs.readFileSync('controls.json', 'utf8'));
    fs.appendFileSync('events.jsonl', JSON.stringify({ action, args, cwd: process.cwd() }) + '\\n');
    if (action === 'setup') {
      if (controls.failSetup) process.exit(12);
      fs.writeFileSync('setup.done', 'ready');
    } else {
      if (controls.requireSetup && !fs.existsSync('setup.done')) process.exit(13);
      if (action === 'discover' || action === 'override-discover') {
        if (controls.failDiscover) process.exit(14);
        const ids = action === 'override-discover' ? ['tests/override test.rb'] : controls.tests;
        if (ids.length) process.stdout.write(ids.join('\\n') + '\\n');
      } else if (action === 'run' || action === 'override-run') {
        const [id, coveragePath, coverageDir, worker] = args;
        if ((controls.failTests || []).includes(id)) process.exit(15);
        if ((controls.noCoverageTests || []).includes(id)) process.exit(0);
        if (!coveragePath || !coverageDir || !worker) process.exit(16);
        if (path.resolve(coverageDir) !== path.dirname(path.resolve(coveragePath))) process.exit(17);
        if (controls.requireCoverageDir && !fs.existsSync(coverageDir)) process.exit(20);
        fs.mkdirSync(path.dirname(coveragePath), { recursive: true });
        if (action === 'override-run') {
          fs.writeFileSync(coveragePath, JSON.stringify({
            'src/override.rb': {
              statementMap: { 0: { start: { line: 11 }, end: { line: 12 } } },
              s: { 0: 1 },
            },
          }));
        } else {
          const line = id === 'tests/alpha test.rb' ? 3 : 7;
          fs.writeFileSync(coveragePath, 'TN:\\nSF:src/calculator.rb\\nDA:' + line + ',1\\nDA:99,0\\nend_of_record\\n');
        }
      } else if (action === 'full') {
        if (controls.failFull) process.exit(18);
      } else {
        process.exit(19);
      }
    }
  `);

  const command = (action) => `"${process.execPath}" "fixture runner.cjs" ${action}`;
  const runCommand = (action = 'run') => `${command(action)} "{{TEST}}" "{{COVERAGE_PATH}}" "{{COVERAGE_DIR}}" "{{WORKER}}"`;
  const configPath = path.join(cwd, configName);
  const config = {
    adapter: 'custom',
    setup: command('setup'),
    discover: command('discover'),
    run: runCommand(),
    full: command('full'),
    coverage: { format: 'lcov', path: 'coverage output/lcov.info' },
  };
  const writeConfig = (value = config) => {
    const lines = [];
    for (const key of ['adapter', 'setup', 'discover', 'run', 'full']) {
      if (value[key] !== undefined) lines.push(`${key}: ${JSON.stringify(value[key])}`);
    }
    if (value.coverage) {
      lines.push('coverage:', `  format: ${JSON.stringify(value.coverage.format)}`, `  path: ${JSON.stringify(value.coverage.path)}`);
    }
    fs.writeFileSync(configPath, lines.join('\n') + '\n');
  };
  writeConfig();

  return {
    cwd,
    temporaryRoot,
    configPath,
    config,
    command,
    runCommand,
    writeConfig,
    events() {
      const eventPath = path.join(cwd, 'events.jsonl');
      if (!fs.existsSync(eventPath)) return [];
      return fs.readFileSync(eventPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    },
  };
}

function run(cwd, args) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
    env: { ...process.env, NO_COLOR: '1' },
  });
  assert.ifError(result.error);
  return result;
}

function succeeds(result) {
  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
}

function fails(result) {
  assert.notEqual(result.status, 0, `Unexpected success:\n${result.stdout}\n${result.stderr}`);
}

function readMap(cwd, filename = 'map.json') {
  return JSON.parse(fs.readFileSync(path.join(cwd, filename), 'utf8'));
}

test('discover loads root testpilot.yml without executing repository commands', t => {
  const project = fixture(t);
  const result = run(project.cwd, ['discover']);
  succeeds(result);
  const discovered = JSON.parse(result.stdout);
  assert.equal(discovered.adapter, 'custom');
  assert.equal(discovered.test_list_command, project.config.discover);
  assert.equal(discovered.test_run_command_template, project.config.run);
  assert.equal(discovered.setup_command, project.config.setup);
  assert.equal(discovered.full_test_command, project.config.full);
  assert.equal(discovered.coverage_format, project.config.coverage.format);
  assert.equal(discovered.coverage_path, project.config.coverage.path);
  assert.equal(path.resolve(discovered.config_path), project.configPath);
  assert.equal(path.resolve(discovered.working_directory), project.cwd);
  assert.deepEqual(project.events(), []);
});

test('setup runs configured setup once, and setup is optional', t => {
  const project = fixture(t);
  succeeds(run(project.cwd, ['setup']));
  assert.deepEqual(project.events().map(event => event.action), ['setup']);
  project.writeConfig({ ...project.config, setup: undefined });
  succeeds(run(project.cwd, ['setup']));
  assert.deepEqual(project.events().map(event => event.action), ['setup']);
});

test('map uses configuration automatically and runs setup before discovery and each test', t => {
  const project = fixture(t);
  succeeds(run(project.cwd, ['map', '--out', 'map.json']));
  assert.deepEqual(project.events().map(event => event.action), ['setup', 'discover', 'run', 'run']);
  assert.ok(project.events().every(event => event.cwd === project.cwd));
  const mapped = readMap(project.cwd);
  assert.deepEqual(mapped.tests.map(entry => ({ id: entry.id, files: entry.files })), [
    { id: testIds[0], files: [{ path: 'src/calculator.rb', lines: [3] }] },
    { id: testIds[1], files: [{ path: 'src/calculator.rb', lines: [7] }] },
  ]);
});

test('explicit config uses its directory for commands and caller directory for output', t => {
  const project = fixture(t, {}, 'custom config.yaml');
  const caller = path.join(project.temporaryRoot, 'caller with spaces');
  fs.mkdirSync(caller);
  succeeds(run(caller, ['map', '--config', project.configPath, '--out', 'artifacts/map.json']));
  assert.ok(project.events().every(event => event.cwd === project.cwd));
  assert.equal(readMap(caller, 'artifacts/map.json').tests.length, 2);
  assert.equal(fs.existsSync(path.join(project.cwd, 'artifacts/map.json')), false);
});

test('explicit mapping commands and coverage options override config defaults', t => {
  const project = fixture(t);
  succeeds(run(project.cwd, [
    'map', '--out', 'map.json',
    '--test-list', project.command('override-discover'),
    '--test-run', project.runCommand('override-run'),
    '--format', 'c8', '--coverage', 'override coverage/custom.json',
  ]));
  assert.deepEqual(project.events().map(event => event.action), ['setup', 'override-discover', 'override-run']);
  assert.deepEqual(readMap(project.cwd).tests.map(entry => ({ id: entry.id, files: entry.files })), [
    { id: 'tests/override test.rb', files: [{ path: 'src/override.rb', lines: [11, 12] }] },
  ]);
  assert.equal(fs.existsSync(path.join(project.cwd, project.config.coverage.path)), false);
  assert.ok(fs.existsSync(path.join(project.cwd, 'override coverage/custom.json')));
});

test('skip-setup allows mapping an already prepared repository', t => {
  const project = fixture(t, { requireSetup: false });
  succeeds(run(project.cwd, ['map', '--out', 'map.json', '--skip-setup', 'true']));
  assert.deepEqual(project.events().map(event => event.action), ['discover', 'run', 'run']);
  assert.equal(readMap(project.cwd).tests.length, 2);
});

test('parallel mapping isolates worker coverage and preserves each test coverage', t => {
  const project = fixture(t);
  succeeds(run(project.cwd, ['map', '--out', 'map.json', '--jobs', '2']));
  const events = project.events();
  assert.deepEqual(events.slice(0, 2).map(event => event.action), ['setup', 'discover']);
  const runs = events.filter(event => event.action === 'run');
  assert.equal(runs.length, 2);
  assert.equal(new Set(runs.map(event => path.resolve(project.cwd, event.args[1]))).size, 2);
  assert.deepEqual(runs.map(event => event.args[3]).sort(), ['1', '2']);
  for (const event of runs) {
    assert.ok(fs.existsSync(path.resolve(project.cwd, event.args[1])));
  }
  const mapped = readMap(project.cwd);
  assert.deepEqual(mapped.tests.map(entry => entry.id).sort(), testIds);
  assert.deepEqual(mapped.tests.find(entry => entry.id === testIds[0]).files, [
    { path: 'src/calculator.rb', lines: [3] },
  ]);
  assert.deepEqual(mapped.tests.find(entry => entry.id === testIds[1]).files, [
    { path: 'src/calculator.rb', lines: [7] },
  ]);
});

test('serial mapping expands WORKER in configured coverage path to worker one', t => {
  const project = fixture(t);
  project.writeConfig({
    ...project.config,
    coverage: { format: 'lcov', path: 'coverage output/worker-{{WORKER}}/lcov.info' },
  });
  succeeds(run(project.cwd, ['map', '--out', 'map.json']));
  const runs = project.events().filter(event => event.action === 'run');
  assert.equal(runs.length, 2);
  for (const event of runs) {
    assert.equal(event.args[1].replace(/\\/g, '/'), 'coverage output/worker-1/lcov.info');
    assert.equal(event.args[3], '1');
  }
  assert.equal(readMap(project.cwd).tests.length, 2);
  assert.ok(fs.existsSync(path.join(project.cwd, 'coverage output/worker-1/lcov.info')));
  assert.equal(fs.existsSync(path.join(project.cwd, 'coverage output/worker-{{WORKER}}')), false);
});

test('explicit mapping commands remain supported without a configuration file', t => {
  const project = fixture(t, { requireSetup: false });
  fs.unlinkSync(project.configPath);
  succeeds(run(project.cwd, [
    'map', '--out', 'map.json', '--format', 'lcov',
    '--coverage', 'coverage output/lcov.info',
    '--test-list', project.command('discover'),
    '--test-run', project.runCommand(),
  ]));
  assert.deepEqual(project.events().map(event => event.action), ['discover', 'run', 'run']);
  assert.deepEqual(readMap(project.cwd).tests.map(entry => entry.id), testIds);
});

test('configured mapping and selection run only the test covering a changed line', t => {
  const project = fixture(t);
  succeeds(run(project.cwd, ['map', '--out', 'map.json']));
  fs.writeFileSync(path.join(project.cwd, 'pr.json'), JSON.stringify([
    { filename: 'src/calculator.rb', patch: '@@ -7 +7 @@\n-old_value\n+new_value' },
  ]));
  succeeds(run(project.cwd, [
    'select', '--map', 'map.json', '--pr', 'pr.json', '--out', 'selected.txt',
  ]));
  assert.equal(fs.readFileSync(path.join(project.cwd, 'selected.txt'), 'utf8').trim(), testIds[1]);
  const previousEvents = project.events().length;
  succeeds(run(project.cwd, ['run', '--tests', 'selected.txt', '--skip-setup', 'true']));
  const selectedRun = project.events().slice(previousEvents);
  assert.equal(selectedRun.length, 1);
  assert.equal(selectedRun[0].action, 'run');
  assert.equal(selectedRun[0].args[0], testIds[1]);
});

test('map rejects an empty discovered test list', t => {
  const project = fixture(t, { tests: [] });
  fails(run(project.cwd, ['map', '--out', 'map.json']));
  assert.deepEqual(project.events().map(event => event.action), ['setup', 'discover']);
  assert.equal(fs.existsSync(path.join(project.cwd, 'map.json')), false);
});

test('map rejects stale coverage when a successful test writes no new report', t => {
  const project = fixture(t, { tests: [testIds[0]], noCoverageTests: [testIds[0]] });
  const coverage = path.join(project.cwd, project.config.coverage.path);
  fs.mkdirSync(path.dirname(coverage), { recursive: true });
  fs.writeFileSync(coverage, 'SF:src/stale.rb\nDA:1,1\nend_of_record\n');
  const result = run(project.cwd, ['map', '--out', 'map.json']);
  fails(result);
  assert.match(result.stderr, /coverage/i);
  assert.equal(fs.existsSync(path.join(project.cwd, 'map.json')), false);
});

test('map does not reuse the previous test coverage for a later test', t => {
  const project = fixture(t, { noCoverageTests: [testIds[1]] });
  const result = run(project.cwd, ['map', '--out', 'map.json']);
  fails(result);
  assert.match(result.stderr, /coverage/i);
  assert.deepEqual(project.events().map(event => event.action), ['setup', 'discover', 'run', 'run']);
  assert.equal(fs.existsSync(path.join(project.cwd, 'map.json')), false);
});

test('setup and discovery failures stop mapping before tests execute', t => {
  const setupFailure = fixture(t, { failSetup: true });
  fails(run(setupFailure.cwd, ['map', '--out', 'map.json']));
  assert.deepEqual(setupFailure.events().map(event => event.action), ['setup']);

  const discoveryFailure = fixture(t, { failDiscover: true });
  fails(run(discoveryFailure.cwd, ['map', '--out', 'map.json']));
  assert.deepEqual(discoveryFailure.events().map(event => event.action), ['setup', 'discover']);
});

test('test failures reject mapping by default; opt-in skipping keeps only successful tests', t => {
  const strict = fixture(t, { failTests: [testIds[0]] });
  fails(run(strict.cwd, ['map', '--out', 'map.json']));
  assert.equal(fs.existsSync(path.join(strict.cwd, 'map.json')), false);

  const partial = fixture(t, { failTests: [testIds[0]] });
  succeeds(run(partial.cwd, ['map', '--out', 'map.json', '--continue-on-test-failure', 'true']));
  assert.deepEqual(readMap(partial.cwd).tests.map(entry => entry.id), [testIds[1]]);

  const allFailed = fixture(t, { failTests: testIds });
  fails(run(allFailed.cwd, ['map', '--out', 'map.json', '--continue-on-test-failure', 'true']));
  assert.equal(fs.existsSync(path.join(allFailed.cwd, 'map.json')), false);
});

test('run --full performs setup then executes the configured full suite and propagates failures', t => {
  const project = fixture(t);
  succeeds(run(project.cwd, ['run', '--full']));
  assert.deepEqual(project.events().map(event => event.action), ['setup', 'full']);

  const failing = fixture(t, { failFull: true });
  fails(run(failing.cwd, ['run', '--full']));
  assert.deepEqual(failing.events().map(event => event.action), ['setup', 'full']);
});

test('run --tests resolves selection from caller and expands all run placeholders', t => {
  const project = fixture(t, { requireCoverageDir: true }, 'custom config.yaml');
  const caller = path.join(project.temporaryRoot, 'selection caller');
  fs.mkdirSync(caller);
  fs.writeFileSync(path.join(caller, 'selected tests.txt'), `${testIds[1]}\n${testIds[0]}\n`);
  succeeds(run(caller, ['run', '--config', project.configPath, '--tests', 'selected tests.txt']));
  const events = project.events();
  assert.deepEqual(events.map(event => event.action), ['setup', 'run', 'run']);
  assert.deepEqual(events.filter(event => event.action === 'run').map(event => event.args[0]), [testIds[1], testIds[0]]);
  assert.ok(events.every(event => event.cwd === project.cwd));
});

test('run with an empty selection falls back to the full suite', t => {
  const project = fixture(t, { requireSetup: false });
  fs.writeFileSync(path.join(project.cwd, 'selected.txt'), '\n  \n');
  succeeds(run(project.cwd, ['run', '--tests', 'selected.txt', '--skip-setup', 'true']));
  assert.deepEqual(project.events().map(event => event.action), ['full']);
});

test('unknown commands fail with usage rather than executing configured commands', t => {
  const project = fixture(t);
  const result = run(project.cwd, ['not-a-command']);
  fails(result);
  assert.match(result.stdout + result.stderr, /usage/i);
  assert.deepEqual(project.events(), []);
});
