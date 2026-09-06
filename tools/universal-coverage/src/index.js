const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const { parseJacoco } = require('./adapters/jacoco');
const { parseLcov } = require('./adapters/lcov');
const { parseC8 } = require('./adapters/c8');
const {
  loadJson,
  saveJson,
  ensureDir,
  forEachUniversalMapTest,
} = require('./lib/io');
const { prDiffToChangedRanges } = require('./lib/diff');
const { discoverTestSetup, discoverAllTestSetups } = require('./lib/discovery');
const { loadRepoConfig } = require('./lib/config');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const hasNextValue =
        i + 1 < argv.length && !argv[i + 1].startsWith('--');
      const v = hasNextValue ? argv[++i] : 'true';
      args[k] = v;
    }
  }
  return args;
}

function parseCoverage(format, coveragePath) {
  if (!fs.existsSync(coveragePath)) {
    throw new Error(`Test produced no coverage file: ${coveragePath}`);
  }
  if (format === 'jacoco') return parseJacoco(coveragePath);
  if (format === 'lcov') return parseLcov(coveragePath);
  if (format === 'c8') return parseC8(coveragePath);
  throw new Error(`Unsupported format: ${format}`);
}

function buildUniversalTestEntry(testId, fileToLines) {
  const files = [];
  for (const [p, linesSet] of fileToLines.entries()) {
    files.push({ path: p, lines: Array.from(linesSet).sort((a, b) => a - b) });
  }
  return { id: testId, type: 'unknown', files };
}

function parsePositiveInt(raw, fallback) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

function expandTemplate(template, vars) {
  let out = template;
  for (const [k, v] of Object.entries(vars)) {
    out = out.replaceAll(`{{${k}}}`, String(v));
  }
  return out;
}

function getCoveragePathForWorker(coveragePath, workerId) {
  if (coveragePath.includes('{{WORKER}}')) {
    return coveragePath.replaceAll('{{WORKER}}', String(workerId));
  }
  const dir = path.dirname(coveragePath);
  const base = path.basename(coveragePath);
  return path.join(dir, `worker-${workerId}`, base);
}

function runShellCommand(cmd, cwd = process.cwd()) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, {
      shell: true,
      stdio: 'inherit',
      cwd,
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) return resolve();
      const reason = signal
        ? `signal ${signal}`
        : `exit code ${String(code)}`;
      reject(new Error(`Command failed (${reason}): ${cmd}`));
    });
  });
}

function runConfiguredSetup(configured, args) {
  if (configured?.setup_command && args['skip-setup'] !== 'true') {
    console.log(`Running setup from ${configured.config_path}`);
    execSync(configured.setup_command, {
      cwd: configured.working_directory, stdio: 'inherit',
    });
  }
}

function requireRepoConfig(args) {
  const configured = loadRepoConfig({ configPath: args.config });
  if (!configured) throw new Error('This command requires testpilot.yml (or --config <path>)');
  return configured;
}

function cmdSetup(args) {
  runConfiguredSetup(requireRepoConfig(args), args);
}

function cmdRun(args) {
  const configured = requireRepoConfig(args);
  const full = args.full === 'true';
  if (full === Boolean(args.tests)) {
    throw new Error('run requires exactly one of --full or --tests <selected_tests.txt>');
  }
  const tests = full ? [] : fs.readFileSync(args.tests, 'utf8')
    .split(/\r?\n/).map(test => test.trim()).filter(Boolean);
  runConfiguredSetup(configured, args);
  const cwd = configured.working_directory;
  if (full || tests.length === 0) {
    if (!full) console.log('No selected tests; running the configured full suite.');
    execSync(configured.full_test_command, { cwd, stdio: 'inherit' });
    return;
  }
  const coveragePath = (args.coverage || configured.coverage_path).replaceAll('{{WORKER}}', '1');
  fs.mkdirSync(path.dirname(path.resolve(cwd, coveragePath)), { recursive: true });
  for (const test of new Set(tests)) {
    const command = expandTemplate(args['test-run'] || configured.test_run_command_template, {
      TEST: test, WORKER: 1, COVERAGE_PATH: coveragePath,
      COVERAGE_DIR: path.dirname(coveragePath),
    });
    execSync(command, { cwd, stdio: 'inherit' });
  }
}

async function cmdMap(args) {
  const configured = loadRepoConfig({ configPath: args.config });
  const autoDiscoverTests = args['auto-discover-tests'] === 'true';
  const cwd = configured?.working_directory || process.cwd();
  const format = args.format || configured?.coverage_format || (autoDiscoverTests ? 'c8' : null);
  const coveragePath = args.coverage || configured?.coverage_path ||
    (autoDiscoverTests ? 'coverage/coverage-final.json' : null);
  const outPath = args.out;
  const continueOnTestFailure = args['continue-on-test-failure'] === 'true';
  let jobs = parsePositiveInt(args.jobs || '1', 1);

  let testListCmd = args['test-list'] || configured?.test_list_command;
  let testRunTemplate = args['test-run'] || configured?.test_run_command_template;

  if ((!testListCmd || !testRunTemplate) && autoDiscoverTests) {
    const detected = discoverTestSetup({ probe: true });
    testListCmd = testListCmd || detected.test_list_command;
    testRunTemplate = testRunTemplate || detected.test_run_command_template;
    console.log(
      `Auto-discovered test setup: ${detected.adapter} (${detected.source}, confidence=${detected.confidence}, score=${detected.score ?? detected.confidence})`,
    );
    if (detected.probe && Array.isArray(detected.probe.missing_commands) && detected.probe.missing_commands.length > 0) {
      console.warn(
        `Missing required commands for selected adapter: ${detected.probe.missing_commands.join(', ')}`,
      );
    }
    if (Array.isArray(detected.warnings)) {
      for (const w of detected.warnings) console.warn(w);
    }
  }

  if (
    !format ||
    !coveragePath ||
    !outPath ||
    !testListCmd ||
    !testRunTemplate
  ) {
    throw new Error(
      'map requires --format --coverage --out --test-list --test-run',
    );
  }

  if (!['c8', 'lcov', 'jacoco'].includes(format)) {
    throw new Error(`Unsupported format: ${format}`);
  }

  if (
    jobs > 1 &&
    !testRunTemplate.includes('{{WORKER}}') &&
    !testRunTemplate.includes('{{COVERAGE_PATH}}') &&
    !testRunTemplate.includes('{{COVERAGE_DIR}}') &&
    !coveragePath.includes('{{WORKER}}')
  ) {
    console.warn(
      'Requested parallel mapping but test run template does not isolate coverage output. Falling back to --jobs 1. Use {{WORKER}} or {{COVERAGE_PATH}} in --test-run (or {{WORKER}} in --coverage) to enable safe parallelism.',
    );
    jobs = 1;
  }

  runConfiguredSetup(configured, args);
  // Commands print only one test ID per line on stdout; diagnostics belong on stderr.
  const testList = [...new Set(execSync(testListCmd, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean))];
  if (testList.length === 0) throw new Error('Test discovery returned no tests; refusing to write an empty coverage map');
  console.log(
    `Mapping ${testList.length} test(s) with ${jobs} worker(s).`,
  );

  const failedTests = [];
  let mappedCount = 0;
  let wroteAnyEntry = false;
  let writeCompleted = false;

  ensureDir(outPath);
  const outFd = fs.openSync(outPath, 'w');
  fs.writeSync(outFd, '{"tests":[\n');

  try {
    let nextIndex = 0;
    let fatalError = null;
    const runWorker = async (workerId) => {
      while (true) {
        if (fatalError) return;
        const idx = nextIndex++;
        if (idx >= testList.length) return;

        const testId = testList[idx];
        const workerCoveragePath =
          jobs === 1 ? coveragePath.replaceAll('{{WORKER}}', String(workerId)) : getCoveragePathForWorker(coveragePath, workerId);
        const reportPath = path.resolve(cwd, workerCoveragePath);
        const cmd = expandTemplate(testRunTemplate, {
          TEST: testId,
          WORKER: workerId,
          COVERAGE_PATH: workerCoveragePath,
          COVERAGE_DIR: path.dirname(workerCoveragePath),
        });

        console.log(`\n=== Running test (worker ${workerId}): ${testId} ===\n${cmd}\n`);

        let fileToLines;
        try {
          fs.mkdirSync(path.dirname(reportPath), { recursive: true });
          fs.rmSync(reportPath, { force: true });
          if (jobs === 1) execSync(cmd, { cwd, stdio: 'inherit' });
          else await runShellCommand(cmd, cwd);
          fileToLines = parseCoverage(format, reportPath);
          if (fileToLines.size === 0) throw new Error(`Coverage report contains no source files: ${reportPath}`);
        } catch (err) {
          if (!continueOnTestFailure) {
            fatalError = err;
            throw err;
          }
          failedTests.push(testId);
          console.warn(`Skipping failed test in map generation: ${testId}: ${err.message}`);
          continue;
        }

        const entry = buildUniversalTestEntry(testId, fileToLines);
        if (wroteAnyEntry) fs.writeSync(outFd, ',\n');
        fs.writeSync(outFd, JSON.stringify(entry));
        wroteAnyEntry = true;
        mappedCount += 1;
      }
    };

    const workerCount = Math.min(jobs, Math.max(1, testList.length));
    const workers = [];
    for (let worker = 1; worker <= workerCount; worker += 1) {
      workers.push(runWorker(worker));
    }
    const results = await Promise.allSettled(workers);
    const failure = results.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
    if (mappedCount === 0) throw new Error('No tests produced usable coverage; refusing to write an empty coverage map');

    fs.writeSync(outFd, '\n]}\n');
    writeCompleted = true;
  } finally {
    fs.closeSync(outFd);
    if (!writeCompleted) {
      fs.rmSync(outPath, { force: true });
    }
  }

  console.log(`\nWrote universal map: ${outPath} (${mappedCount} test entries)`);
  if (failedTests.length > 0) {
    console.warn(
      `Map generated with ${failedTests.length} failed test(s) skipped.`,
    );
  }
}

function cmdDiscover(args) {
  const outPath = args.out;
  const candidates = discoverAllTestSetups({ probe: true, configPath: args.config });
  const detected = candidates[0];
  const payload = {
    adapter: detected.adapter,
    source: detected.source,
    confidence: detected.confidence,
    score: detected.score ?? detected.confidence,
    config_path: detected.config_path || null,
    working_directory: detected.working_directory || process.cwd(),
    setup_command: detected.setup_command || null,
    full_test_command: detected.full_test_command || null,
    coverage_format: detected.coverage_format || null,
    coverage_path: detected.coverage_path || null,
    test_list_command: detected.test_list_command,
    test_run_command_template: detected.test_run_command_template,
    probe: detected.probe || null,
    warnings: detected.warnings || [],
    candidates: candidates.map((candidate) => ({
      adapter: candidate.adapter,
      source: candidate.source,
      confidence: candidate.confidence,
      score: candidate.score ?? candidate.confidence,
      test_list_command: candidate.test_list_command,
      test_run_command_template: candidate.test_run_command_template,
      probe: candidate.probe || null,
      warnings: candidate.warnings || [],
    })),
  };

  if (outPath) {
    ensureDir(outPath);
    saveJson(outPath, payload);
  }
  console.log(JSON.stringify(payload, null, 2));
}

async function cmdMerge(args) {
  const basePath = args.base;
  const deltaPath = args.delta;
  const outPath = args.out;
  const removePath = args.remove;

  if (!basePath || !deltaPath || !outPath) {
    throw new Error('merge requires --base --delta --out [--remove <ids.txt>]');
  }

  const removeIds = new Set();
  if (removePath && fs.existsSync(removePath)) {
    const raw = fs.readFileSync(removePath, 'utf8');
    for (const id of raw.split('\n').map((s) => s.trim()).filter(Boolean)) {
      removeIds.add(id);
    }
  }

  const deltaIds = new Set();
  await forEachUniversalMapTest(deltaPath, (t) => {
    if (t && t.id) deltaIds.add(t.id);
  });

  ensureDir(outPath);
  const outFd = fs.openSync(outPath, 'w');
  let wroteAnyEntry = false;
  let keptFromBase = 0;
  let removedFromBase = 0;
  let addedFromDelta = 0;

  const writeEntry = (entry) => {
    if (wroteAnyEntry) fs.writeSync(outFd, ',\n');
    fs.writeSync(outFd, JSON.stringify(entry));
    wroteAnyEntry = true;
  };

  fs.writeSync(outFd, '{"tests":[\n');
  try {
    await forEachUniversalMapTest(basePath, (t) => {
      if (!t || !t.id) return;
      if (removeIds.has(t.id) || deltaIds.has(t.id)) {
        removedFromBase += 1;
        return;
      }
      keptFromBase += 1;
      writeEntry(t);
    });

    await forEachUniversalMapTest(deltaPath, (t) => {
      if (!t || !t.id) return;
      if (removeIds.has(t.id)) return;
      addedFromDelta += 1;
      writeEntry(t);
    });

    fs.writeSync(outFd, '\n]}\n');
  } finally {
    fs.closeSync(outFd);
  }

  console.log(
    `Merged map written: ${outPath} (kept ${keptFromBase}, replaced/removed ${removedFromBase}, added ${addedFromDelta})`,
  );
}

function intersectsChangedRanges(fileEntry, changedRanges) {
  // changedRanges: Map<path, Array<[start,end]>>
  const ranges = getChangedRangesForPath(changedRanges, fileEntry.path);
  if (!ranges || ranges.length === 0) return false;

  // If no lines recorded, treat file-level match
  if (!fileEntry.lines || fileEntry.lines.length === 0) return true;

  // Check any covered line is in any changed range
  for (const line of fileEntry.lines) {
    for (const [s, e] of ranges) {
      if (line >= s && line <= e) return true;
    }
  }
  return false;
}

function normalizePathForMatch(p) {
  return String(p || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '');
}

const normalizedChangedRangesCache = new WeakMap();

function getChangedRangesForPath(changedRanges, filePath) {
  const normalizedFilePath = normalizePathForMatch(filePath);

  // 1) Fast exact (normalized) match
  let normalized = normalizedChangedRangesCache.get(changedRanges);
  if (normalized == null) {
    const normalizedMap = new Map();
    for (const [k, v] of changedRanges.entries()) {
      normalizedMap.set(normalizePathForMatch(k), v);
    }
    normalizedChangedRangesCache.set(changedRanges, normalizedMap);
    normalized = normalizedChangedRangesCache.get(changedRanges);
  }
  const direct = normalized.get(normalizedFilePath);
  if (direct) return direct;

  // 2) Fallback for absolute-vs-relative mismatches:
  // map path ".../repo/lib/x.js" should match PR path "lib/x.js".
  let bestKey = null;
  for (const k of normalized.keys()) {
    if (
      normalizedFilePath === k ||
      normalizedFilePath.endsWith(`/${k}`)
    ) {
      if (bestKey == null || k.length > bestKey.length) bestKey = k;
    }
  }
  if (bestKey) return normalized.get(bestKey);
  return null;
}

async function cmdSelect(args) {
  const mapPath = args.map;
  const prPath = args.pr;
  const outPath = args.out;

  if (!mapPath || !prPath || !outPath) {
    throw new Error('select requires --map --pr --out');
  }

  const prFiles = loadJson(prPath); // [{filename, patch}...]

  const changedRanges = prDiffToChangedRanges(prFiles);
  console.log(`Selection input: ${prFiles.length} changed file(s).`);

  ensureDir(outPath);
  const outFd = fs.openSync(outPath, 'w');
  let mappedCount = 0;
  let selectedCount = 0;

  try {
    await forEachUniversalMapTest(mapPath, (t) => {
      mappedCount += 1;
      const hit = (t.files || []).some((f) =>
        intersectsChangedRanges(f, changedRanges),
      );
      if (!hit) return;
      fs.writeSync(outFd, `${t.id}\n`);
      selectedCount += 1;
    });
  } finally {
    fs.closeSync(outFd);
  }
  console.log(`Scanned ${mappedCount} mapped test(s).`);
  console.log(`Selected ${selectedCount} test(s). Wrote: ${outPath}`);
}

(async function main() {
  const cmd = process.argv[2];
  const args = parseArgs(process.argv.slice(3));

  try {
    if (cmd === 'map') return await cmdMap(args);
    if (cmd === 'setup') return cmdSetup(args);
    if (cmd === 'run') return cmdRun(args);
    if (cmd === 'discover') return cmdDiscover(args);
    if (cmd === 'select') return await cmdSelect(args);
    if (cmd === 'merge') return await cmdMerge(args);
    console.log('Usage:');
    console.log(
      '  node src/index.js map --out <json> [--config <path>] [--format c8|lcov|jacoco] [--coverage <path>] [--test-list <cmd>] [--test-run <cmdTemplate>] [--jobs <n>] [--skip-setup true] [--auto-discover-tests true] [--continue-on-test-failure true]',
    );
    console.log(
      '  node src/index.js discover [--config <path>] [--out <json>]',
    );
    console.log('  node src/index.js setup [--config <path>]');
    console.log('  node src/index.js run (--full | --tests <selected_tests.txt>) [--config <path>] [--skip-setup true]');
    console.log(
      '  node src/index.js select --map <json> --pr <pr_files.json> --out <selected_tests.txt>',
    );
    console.log(
      '  node src/index.js merge --base <base_map.json> --delta <delta_map.json> --out <merged_map.json> [--remove <ids.txt>]',
    );
    process.exit(1);
  } catch (e) {
    console.error(e?.stack || e?.message || String(e));
    process.exit(1);
  }
})();
