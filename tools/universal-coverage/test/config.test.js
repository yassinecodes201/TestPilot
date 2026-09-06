const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadRepoConfig } = require('../src/lib/config');

const valid = {
  adapter: 'custom',
  setup: './ci/install.sh',
  discover: './ci/list-tests.sh',
  run: './ci/run-test.sh "{{TEST}}"',
  full: './ci/run-all.sh',
  coverage: { format: 'lcov', path: 'coverage/worker-{{WORKER}}/lcov.info' },
};

function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'testpilot-config-'));
  t.after(() => {
    assert.ok(path.resolve(cwd).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  return cwd;
}

function writeConfig(cwd, value, name = 'testpilot.yml') {
  fs.writeFileSync(path.join(cwd, name), typeof value === 'string' ? value : JSON.stringify(value));
}

test('missing default configuration allows automatic discovery', t => {
  assert.equal(loadRepoConfig({ cwd: fixture(t) }), null);
});

test('reads custom YAML configuration including block commands', t => {
  const cwd = fixture(t);
  writeConfig(cwd, `adapter: custom
setup: ./ci/install.sh
discover: |
  ./ci/list-tests.sh
run: './ci/run-test.sh "{{TEST}}"'
full: ./ci/run-all.sh
coverage:
  format: lcov
  path: coverage/worker-{{WORKER}}/lcov.info
`);
  assert.deepEqual(loadRepoConfig({ cwd }), {
    adapter: 'custom', source: 'config', confidence: 1, score: 2,
    config_path: path.join(cwd, 'testpilot.yml'), working_directory: cwd,
    setup_command: valid.setup,
    test_list_command: valid.discover,
    test_run_command_template: valid.run,
    full_test_command: valid.full,
    coverage_format: valid.coverage.format,
    coverage_path: valid.coverage.path,
    required_commands: [], warnings: [],
  });
});

test('supports .yaml, optional setup and all existing report formats', t => {
  const cwd = fixture(t);
  for (const format of ['c8', 'lcov', 'jacoco']) {
    writeConfig(cwd, { ...valid, setup: undefined, coverage: { format, path: 'reports/report' } }, 'testpilot.yaml');
    const config = loadRepoConfig({ cwd });
    assert.equal(config.coverage_format, format);
    assert.equal(config.setup_command, null);
  }
});

test('explicit config resolves commands and paths from the config directory', t => {
  const cwd = fixture(t);
  fs.mkdirSync(path.join(cwd, 'backend'));
  writeConfig(path.join(cwd, 'backend'), valid, 'custom.yaml');
  const config = loadRepoConfig({ cwd, configPath: 'backend/custom.yaml' });
  assert.equal(config.config_path, path.join(cwd, 'backend/custom.yaml'));
  assert.equal(config.working_directory, path.join(cwd, 'backend'));
});

test('ambiguous defaults and explicitly missing files fail with actionable errors', t => {
  const cwd = fixture(t);
  assert.throws(() => loadRepoConfig({ cwd, configPath: 'missing.yml' }), /does not exist/);
  assert.throws(() => loadRepoConfig({ cwd, configPath: '' }), /nonempty string/);
  writeConfig(cwd, valid);
  writeConfig(cwd, valid, 'testpilot.yaml');
  assert.throws(() => loadRepoConfig({ cwd }), /Both testpilot.yml and testpilot.yaml/);
  assert.equal(loadRepoConfig({ cwd, configPath: 'testpilot.yaml' }).adapter, 'custom');
});

test('malformed YAML, duplicate fields and non-mapping configurations are rejected', t => {
  const cwd = fixture(t);
  for (const content of ['coverage: [', 'adapter: custom\nadapter: custom', '', '- custom', 'true']) {
    writeConfig(cwd, content);
    assert.throws(() => loadRepoConfig({ cwd }), /Invalid TestPilot config/);
  }
});

test('missing, mistyped and unknown fields never silently fall back to detection', t => {
  const cwd = fixture(t);
  const invalid = [
    [{ ...valid, adapter: 'pytest' }, /adapter must be "custom"/],
    [{ ...valid, setup: '' }, /setup must be a nonempty string/],
    [{ ...valid, setup: null }, /setup must be a nonempty string/],
    [{ ...valid, discover: undefined }, /discover must be a nonempty string/],
    [{ ...valid, run: 42 }, /run must be a nonempty string/],
    [{ ...valid, run: './ci/run.sh' }, /run must include the/],
    [{ ...valid, full: false }, /full must be a nonempty string/],
    [{ ...valid, coverage: undefined }, /coverage must be a mapping/],
    [{ ...valid, coverage: [] }, /coverage must be a mapping/],
    [{ ...valid, coverage: { format: 'cobertura', path: 'coverage.xml' } }, /coverage.format must be/],
    [{ ...valid, coverage: { format: 'lcov' } }, /coverage.path must be a nonempty string/],
    [{ ...valid, install: 'npm ci' }, /unknown configuration field "install"/],
    [{ ...valid, projects: [] }, /projects is not supported/],
    [{ ...valid, coverage: { ...valid.coverage, typo: true } }, /unknown coverage field "typo"/],
  ];
  for (const [value, expected] of invalid) {
    writeConfig(cwd, value);
    assert.throws(() => loadRepoConfig({ cwd }), expected);
  }
});

test('coverage paths stay inside the configuration directory on all platforms', t => {
  const cwd = fixture(t);
  for (const reportPath of ['/tmp/lcov.info', 'C:\\reports\\lcov.info', 'C:lcov.info',
    '\\\\server\\reports\\lcov.info', '../lcov.info', 'coverage/../../lcov.info',
    'coverage\\..\\lcov.info', '.', 'coverage/', 'coverage/{{TEST}}.info']) {
    writeConfig(cwd, { ...valid, coverage: { format: 'lcov', path: reportPath } });
    assert.throws(() => loadRepoConfig({ cwd }), /coverage.path/);
  }
  writeConfig(cwd, { ...valid, coverage: { format: 'lcov', path: 'coverage\\worker-{{WORKER}}\\lcov.info' } });
  assert.equal(loadRepoConfig({ cwd }).coverage_path, 'coverage/worker-{{WORKER}}/lcov.info');
});
