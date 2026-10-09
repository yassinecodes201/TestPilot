const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execSync } = require("node:child_process");
const { discoverTestSetup } = require("../src/lib/discovery");

function fixture(t, pkg) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "testpilot-node-test-"));
  t.after(() => {
    assert.ok(
      path.resolve(cwd).startsWith(path.resolve(os.tmpdir()) + path.sep),
    );
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify(pkg));
  return cwd;
}

test("detects Node built-in test runner when package scripts use node --test", (t) => {
  const cwd = fixture(t, {
    name: "node-test-fixture",
    private: true,
    scripts: {
      test: "node --test",
    },
  });

  const detected = discoverTestSetup({ cwd, probe: false });
  assert.equal(detected.adapter, "node-test");
  assert.match(detected.test_list_command, /\.test\.js/);
  assert.match(detected.test_run_command_template, /node --test/);
  assert.match(detected.test_run_command_template, /"\{\{TEST\}\}"/);
});

test("does not claim packages that do not use node --test", (t) => {
  const cwd = fixture(t, {
    name: "no-node-test-fixture",
    private: true,
    scripts: {
      test: 'echo "no tests"',
    },
  });

  const detected = discoverTestSetup({ cwd, probe: false });
  assert.notEqual(detected.adapter, "node-test");
});

test("repo-root detection for nested universal-coverage emits the failing path with a verified runner", (t) => {
  const cwd = fs.mkdtempSync(
    path.join(os.tmpdir(), "testpilot-root-node-test-"),
  );
  t.after(() => {
    assert.ok(
      path.resolve(cwd).startsWith(path.resolve(os.tmpdir()) + path.sep),
    );
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  const toolDir = path.join(cwd, "tools", "universal-coverage");
  fs.mkdirSync(path.join(toolDir, "src"), { recursive: true });
  fs.mkdirSync(path.join(toolDir, "test"), { recursive: true });
  fs.writeFileSync(
    path.join(toolDir, "src", "index.js"),
    "module.exports = {};\n",
  );
  fs.writeFileSync(
    path.join(toolDir, "package.json"),
    JSON.stringify({
      name: "universal-coverage",
      private: true,
      scripts: { test: "node --test" },
    }),
  );

  const failingPath = "tools/universal-coverage/test/react-source.test.js";
  fs.writeFileSync(path.join(cwd, failingPath), "import 'node:test';\n");

  const detected = discoverTestSetup({ cwd, probe: false });
  assert.equal(detected.adapter, "testpilot-universal-coverage-node-test");
  assert.ok(detected.test_run_command_template.includes("node --test"));
  assert.ok(
    !detected.test_run_command_template.includes("No verified runner detected"),
  );

  assert.ok(detected.test_list_command.includes("tools/universal-coverage/"));
  if (process.platform !== "win32") {
    const listed = execSync(detected.test_list_command, {
      cwd,
      encoding: "utf8",
    })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    assert.ok(listed.includes(failingPath));
  }
});
