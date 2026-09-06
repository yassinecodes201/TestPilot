const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const ROOT_FIELDS = new Set(['adapter', 'setup', 'discover', 'run', 'full', 'coverage']);
const COVERAGE_FIELDS = new Set(['format', 'path']);
const COVERAGE_FORMATS = new Set(['c8', 'lcov', 'jacoco']);

function loadRepoConfig({ cwd = process.cwd(), configPath } = {}) {
  let filename;
  if (configPath !== undefined) {
    if (typeof configPath !== 'string' || !configPath.trim()) {
      throw new Error('TestPilot config path must be a nonempty string.');
    }
    filename = path.resolve(cwd, configPath);
    if (!fs.existsSync(filename)) {
      throw new Error(`TestPilot config does not exist: ${filename}`);
    }
  } else {
    const candidates = ['testpilot.yml', 'testpilot.yaml']
      .map(name => path.resolve(cwd, name))
      .filter(name => fs.existsSync(name));
    if (!candidates.length) return null;
    if (candidates.length > 1) {
      throw new Error('Both testpilot.yml and testpilot.yaml exist; keep one or select one with --config.');
    }
    [filename] = candidates;
  }

  const fail = message => {
    throw new Error(`Invalid TestPilot config ${filename}: ${message}`);
  };
  let config;
  try {
    const document = YAML.parseDocument(fs.readFileSync(filename, 'utf8'), {
      prettyErrors: false,
      uniqueKeys: true,
    });
    if (document.errors.length || document.warnings.length) {
      const issue = document.errors[0] || document.warnings[0];
      throw new Error(issue.message);
    }
    config = document.toJS({ maxAliasCount: 100 });
  } catch (error) {
    fail(`could not read YAML: ${error.message}`);
  }

  function validateFields(value, allowed, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || value instanceof Map) {
      fail(`${label} must be a mapping.`);
    }
    for (const field of Object.keys(value)) {
      if (!allowed.has(field)) {
        if (field === 'projects' && label === 'configuration') {
          fail('projects is not supported; use one custom adapter configuration per file.');
        }
        fail(`unknown ${label} field "${field}".`);
      }
    }
  }

  function nonemptyString(value, label) {
    if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
      fail(`${label} must be a nonempty string without null characters.`);
    }
    return value.trim();
  }

  validateFields(config, ROOT_FIELDS, 'configuration');
  if (config.adapter !== 'custom') fail('adapter must be "custom".');
  const setup = config.setup === undefined ? null : nonemptyString(config.setup, 'setup');
  const discover = nonemptyString(config.discover, 'discover');
  const run = nonemptyString(config.run, 'run');
  const full = nonemptyString(config.full, 'full');
  if (!run.includes('{{TEST}}')) fail('run must include the {{TEST}} placeholder.');

  validateFields(config.coverage, COVERAGE_FIELDS, 'coverage');
  if (!COVERAGE_FORMATS.has(config.coverage.format)) {
    fail('coverage.format must be one of c8, lcov, or jacoco.');
  }
  const coveragePath = nonemptyString(config.coverage.path, 'coverage.path').replace(/\\/g, '/');
  if (path.posix.isAbsolute(coveragePath) || path.win32.isAbsolute(coveragePath) ||
      /^[a-z]:/i.test(coveragePath) || coveragePath.split('/').includes('..')) {
    fail('coverage.path must be relative to the configuration directory and cannot contain "..".');
  }
  if (coveragePath === '.' || coveragePath.endsWith('/')) {
    fail('coverage.path must name a coverage report file.');
  }
  if (/\{\{[^}]*\}\}/.test(coveragePath.replaceAll('{{WORKER}}', ''))) {
    fail('coverage.path only supports the {{WORKER}} placeholder.');
  }

  return {
    adapter: 'custom',
    source: 'config',
    confidence: 1,
    score: 2,
    config_path: filename,
    working_directory: path.dirname(filename),
    setup_command: setup,
    test_list_command: discover,
    test_run_command_template: run,
    full_test_command: full,
    coverage_format: config.coverage.format,
    coverage_path: coveragePath,
    required_commands: [],
    warnings: [],
  };
}

module.exports = { loadRepoConfig };
