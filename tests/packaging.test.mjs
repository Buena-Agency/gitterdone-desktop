import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const read = path => readFile(new URL('../' + path, import.meta.url), 'utf8');

test('Windows has an NSIS installer and macOS keeps app plus DMG', async () => {
  const windows = JSON.parse(await read('src-tauri/tauri.windows.conf.json'));
  const mac = JSON.parse(await read('src-tauri/tauri.macos.conf.json'));
  assert.deepEqual(windows.bundle.targets, ['nsis']);
  assert.deepEqual(mac.bundle.targets, ['app', 'dmg']);
});

test('direct cargo checks use features matching the configured transparent macOS windows', async () => {
  const config = JSON.parse(await read('src-tauri/tauri.conf.json'));
  const cargo = await read('src-tauri/Cargo.toml');
  assert.equal(config.app.macOSPrivateApi, true);
  assert.match(cargo, /^tauri = .*features = \["macos-private-api"\]/m);
});

test('PR checks are read-only, do not sign/publish, and execute functional plus Rust tests', async () => {
  const check = await read('.github/workflows/check.yml');
  assert.match(check, /contents: read/);
  assert.doesNotMatch(check, /secrets\.|tauri-action|signing|gh release|workflow_run|pull_request_target/);
  assert.match(check, /run: npm test/);
  assert.match(check, /cargo check --locked/);
  assert.match(check, /cargo clippy --locked -- -D warnings/);
  assert.match(check, /cargo test --locked --lib/);
});
