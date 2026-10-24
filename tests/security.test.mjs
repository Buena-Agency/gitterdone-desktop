// Configuration and wiring regressions, not a substitute for the Rust tests
// or an actual macOS/Windows webview build in CI.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const json = (path) => JSON.parse(read(path));
const commands = ['gd_focus_started', 'gd_app_ready', 'gd_log', 'gd_open_task',
  'gd_resize_pill', 'gd_move_pill', 'gd_set_anim', 'gd_quit_and_install'];
const mainCommands = ['gd_focus_started', 'gd_app_ready', 'gd_log', 'gd_quit_and_install'];
const pillCommands = ['gd_open_task', 'gd_resize_pill', 'gd_move_pill', 'gd_set_anim', 'gd_log'];

function permissionCommands(identifier) {
  const block = read('src-tauri/permissions/bridge.toml')
    .split('[[permission]]').find((value) => value.includes(`identifier = "${identifier}"`));
  assert.ok(block, `missing permission ${identifier}`);
  const declaration = block.match(/commands\.allow\s*=\s*(\[[^\]]*\])/);
  assert.ok(declaration);
  return JSON.parse(declaration[1]);
}

test('only the two named capabilities are enabled; splash and future files gain no default grant', () => {
  assert.deepEqual(json('src-tauri/tauri.conf.json').app.security.capabilities, ['main-bridge', 'pill-bridge']);
  assert.deepEqual(readdirSync(new URL('src-tauri/capabilities/', root)).sort(), ['main-bridge.json', 'pill-bridge.json']);
});

test('main remote capability contains only its bridge, events and required titlebar actions', () => {
  const capability = json('src-tauri/capabilities/main-bridge.json');
  assert.equal(capability.identifier, 'main-bridge');
  assert.deepEqual(capability.windows, ['main']);
  assert.equal(capability.local, false);
  assert.deepEqual(capability.remote.urls, ['https://app.gitterdone.org/*']);
  assert.deepEqual(capability.permissions, ['allow-main-bridge', 'core:event:allow-listen',
    'core:event:allow-unlisten', 'core:window:allow-start-dragging', 'core:window:allow-toggle-maximize']);
  assert.deepEqual(permissionCommands('allow-main-bridge'), mainCommands);
});

test('pill capability has no updater, native window, opener or local-page grant', () => {
  const capability = json('src-tauri/capabilities/pill-bridge.json');
  assert.equal(capability.identifier, 'pill-bridge');
  assert.deepEqual(capability.windows, ['pill']);
  assert.equal(capability.local, false);
  assert.deepEqual(capability.remote.urls, ['https://app.gitterdone.org/pill', 'https://app.gitterdone.org/pill/']);
  assert.deepEqual(capability.permissions, ['allow-pill-bridge']);
  assert.deepEqual(permissionCommands('allow-pill-bridge'), pillCommands);
});

test('every registered custom command participates in the explicit build manifest', () => {
  const build = read('src-tauri/build.rs');
  assert.match(build, /AppManifest::new\(\)\.commands\(/);
  assert.match(build, /Attributes::new\(\)\.app_manifest\(manifest\)/);
  const manifestCommands = [...build.matchAll(/"(gd_[a-z_]+)"/g)].map((match) => match[1]);
  assert.deepEqual(manifestCommands.sort(), [...commands].sort());
  const lib = read('src-tauri/src/lib.rs');
  const registered = lib.match(/generate_handler!\[([\s\S]*?)\]/)?.[1];
  assert.ok(registered);
  assert.deepEqual(registered.match(/gd_[a-z_]+/g).sort(), [...commands].sort());
});

test('every custom command checks a native-injected caller before its action', () => {
  const lib = read('src-tauri/src/lib.rs');
  for (const command of commands) {
    const body = lib.match(new RegExp(`(?:async )?fn ${command}\\(([^)]*)\\)[^{]*\\{\\s*([^\\n]+)`));
    assert.ok(body, command);
    assert.match(body[1], /window: WebviewWindow/, command);
    assert.equal(body[2].trim(), `authorize(&window, "${command}")?;`, command);
  }
  assert.match(lib, /let url = window\.url\(\)/);
  assert.match(lib, /security::command_allowed\(window\.label\(\), &url, command\)/);
});

test('both remote webviews reject native popups and install navigation guards', () => {
  const lib = read('src-tauri/src/lib.rs');
  assert.equal((lib.match(/\.on_navigation\(/g) ?? []).length, 2);
  assert.equal((lib.match(/\.on_new_window\(/g) ?? []).length, 2);
  assert.equal((lib.match(/NewWindowResponse::Deny/g) ?? []).length, 2);
  assert.doesNotMatch(lib, /starts_with\(&base\)|starts_with\("about:"\)|starts_with\("blob:"\)|starts_with\("data:"\)/);
  assert.match(lib, /if security::allow_external\(url\)/);
  assert.equal((lib.match(/\.open_url\(/g) ?? []).length, 1);
});

test('canonical app configuration and validated task URLs are used by the shell', () => {
  const lib = read('src-tauri/src/lib.rs');
  assert.match(lib, /security::trusted_app_url\(&app_url\(\)\)/);
  assert.match(lib, /security::task_url\(&task_id\)/);
  assert.doesNotMatch(lib, /format!\([^\n]*\?task=/);
  assert.match(lib, /security::bounded_log_message\(msg\)/);
});

test('updater retains the existing public signing key and fixed HTTPS release endpoint', () => {
  const updater = json('src-tauri/tauri.conf.json').plugins.updater;
  assert.deepEqual(updater.endpoints, ['https://github.com/Buena-Agency/gitterdone-desktop/releases/latest/download/latest.json']);
  const decoded = Buffer.from(updater.pubkey, 'base64').toString('utf8');
  assert.match(decoded, /^untrusted comment: minisign public key:/);
  assert.equal(decoded.trim().split('\n').length, 2);
  assert.equal(updater.dangerousInsecureTransportProtocol, undefined);
});
