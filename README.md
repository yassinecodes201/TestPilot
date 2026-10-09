# TestPilot

## Repository configuration

Put `testpilot.yml` at the root of the repository you want to test and commit it
with that repository. TestPilot loads it automatically, before trying to detect
a test runner. `testpilot.yaml` is also supported; use only one default file.

Start from [testpilot.example.yml](testpilot.example.yml):

```yaml
adapter: custom
setup: ./ci/install.sh
discover: ./ci/list-tests.sh
run: ./ci/run-test.sh "{{TEST}}" "{{COVERAGE_PATH}}"
full: ./ci/run-all.sh
coverage:
  format: lcov
  path: coverage/lcov.info
```

Replace the example scripts with commands for your project. `setup` is optional;
all other fields are required. This version supports one custom configuration
per file; it does not support a `projects:` list or built-in adapter names in the
configuration file.

| Field             | Contract                                                                                                                                 |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `setup`           | Install dependencies or prepare the project. Runs once before `map` or `run`, unless `--skip-setup true` is passed.                      |
| `discover`        | Print one stable test ID per line to stdout. Send progress/log messages to stderr. IDs can be file paths or runner-specific identifiers. |
| `run`             | Run exactly the test ID substituted for `{{TEST}}`. For mapping, also write a fresh coverage report for that test.                       |
| `full`            | Run the full test suite.                                                                                                                 |
| `coverage.format` | `lcov`, `c8` (Istanbul JSON), or `jacoco` (XML).                                                                                         |
| `coverage.path`   | Report file path relative to the configuration directory. Absolute paths and `..` are rejected.                                          |

Commands run in the configuration file's directory, using the host shell
(`/bin/sh` on Unix, `cmd.exe` on Windows); use commands available on your runner.
Commands must exit nonzero when setup or tests fail. Keep command templates
quoted as required by that shell: placeholders are text substitutions, not
automatic shell escaping. The `discover` command should emit trusted test IDs
that your command template can pass as a single argument.

The run template accepts `{{TEST}}`, `{{WORKER}}`, `{{COVERAGE_PATH}}`, and
`{{COVERAGE_DIR}}`. For parallel mapping, make your run command write to the
provided coverage path/directory so workers cannot overwrite each other's
reports. Without output isolation, TestPilot uses one worker. `coverage.path`
may also contain `{{WORKER}}`; it expands to `1` for serial runs.

Source paths in coverage should match paths in the repository's Git diff. Each
report must describe the current test only; an aggregate full-suite report
cannot establish which test covers each line. Missing reports, empty source
reports, and empty discovery results fail mapping. TestPilot removes the previous
report before each mapping run to avoid reusing stale coverage. The existing
`--continue-on-test-failure true` option permits a partial map; it still fails if
no test produces usable coverage.

### Using the configuration

First run `npm install` in TestPilot's `tools/universal-coverage` directory. Then,
from the repository being tested (replace `/path/to/TestPilot`):

```sh
# Inspect the resolved configuration; does not execute repository commands.
node /path/to/TestPilot/tools/universal-coverage/src/index.js discover

# Build the coverage map, running setup first.
node /path/to/TestPilot/tools/universal-coverage/src/index.js map --out maps/universal_coverage_map.json

# Run the full suite, or the test IDs written by TestPilot's select command.
node /path/to/TestPilot/tools/universal-coverage/src/index.js run --full
node /path/to/TestPilot/tools/universal-coverage/src/index.js run --tests selected_tests.txt
```

An empty selection file falls back to `full`. A missing selection file is an
error. To prepare the repository separately, use `setup`, then pass
`--skip-setup true` to `map` or `run`.

Use `--config /path/to/custom.yml` to choose a different file or run from outside
the target repository. Commands and coverage paths use that file's directory;
`--out`, `--tests`, and other CLI input/output file paths use your current
directory. Explicit `--test-list`, `--test-run`, `--format`, and `--coverage`
mapping flags override the corresponding configured values. Invalid
configuration fails with an error instead of silently falling back to detection.
For a configuration in a subdirectory, coverage source paths must still match
the repository's Git diff paths; TestPilot does not prepend that subdirectory.

The map-builder GitHub Actions workflow reads the same file. Its nonempty
coverage/test command inputs override the file. With `build_command: auto`, it
runs configured setup once (or skips setup if omitted); an explicit build
command overrides setup, and `build_mode: never` skips it. Configured repositories
get a full map rebuild because custom test IDs cannot be inferred from filenames.
Repositories without a config retain automatic runner detection. This adds CLI
and map-builder support; the webhook/control-suite placeholder is separate.
Built-in Node test-runner projects are also auto-detected when package scripts
use `node --test`, with per-test coverage mapped through c8.

## React source repository

TestPilot's coverage tool includes a `react-source-jest` adapter for the React
source monorepo. It detects `scripts/jest/jest-cli.js` and uses React's wrapper
instead of invoking Jest directly (which React deliberately rejects).

From the React repository root, after installing its dependencies with the
repository's pinned Yarn version, run (replace `/path/to/TestPilot`):

```sh
node /path/to/TestPilot/tools/universal-coverage/src/index.js discover
node /path/to/TestPilot/tools/universal-coverage/src/index.js map --format c8 --coverage coverage/coverage-final.json --auto-discover-tests true --jobs 2 --out maps/universal_coverage_map.json
```

Install TestPilot's tool dependencies with `npm install` in
`tools/universal-coverage` first. Here `c8` identifies the Istanbul JSON input
format; React's Jest runner generates the report itself, with Babel coverage and
source maps enabled. Test IDs are repository-relative file paths, and parallel
workers write separate coverage reports. The map-builder workflow supports both
Yarn 1 (`--frozen-lockfile`) and modern Yarn (`--immutable`).

The automatic React adapter maps the root wrapper's default experimental,
development source suite. The compiler playground, compiler packages, DevTools,
and other release configurations are separate suites; provide explicit
`--test-list` and `--test-run` commands to map those. After upgrading from generic
Jest discovery, run a full map rebuild using `workflow_dispatch` before relying
on incremental maps.

Run configuration, CLI, and adapter regression tests with `npm test` in
`tools/universal-coverage`.
