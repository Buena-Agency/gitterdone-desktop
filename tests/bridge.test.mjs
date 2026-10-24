import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const main = await readFile(new URL('../src-tauri/scripts/main-bridge.js', import.meta.url), 'utf8');
const pill = await readFile(new URL('../src-tauri/scripts/pill-bridge.js', import.meta.url), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));

function harness(source = main, invoke = () => Promise.resolve()) {
  const events = new Map();
  const calls = [];
  let chrome = null;
  let mutation;
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.listeners = new Map(); this.style = {}; }
    append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
    appendChild(node) { this.append(node); }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    setAttribute() {}
    remove() { this.parent.children = this.parent.children.filter(child => child !== this); }
    click() { this.listeners.get('click')?.(); }
  }
  const body = new Element('body');
  const all = node => [node, ...node.children.flatMap(all)];
  const document = {
    body, documentElement: {}, readyState: 'complete',
    querySelector: () => chrome,
    getElementById: id => all(body).find(node => node.id === id),
    createElement: tag => new Element(tag),
  };
  const window = {
    __GD_SHELL_VERSION__: '1.2.3',
    __TAURI__: {
      core: { invoke: (name, args) => { calls.push({ name, args }); return invoke(name, args); } },
      event: { listen: (name, callback) => { events.set(name, callback); return Promise.resolve(() => {}); } },
    },
    addEventListener: (name, callback) => events.set(name, callback),
  };
  vm.runInNewContext(source, {
    window, document, navigator: { platform: 'Win32', userAgent: 'test' },
    MutationObserver: class { constructor(callback) { mutation = callback; } observe() {} disconnect() {} },
    requestAnimationFrame: callback => callback(),
    Promise, Error,
  });
  return { calls, window, events, body, document, ready: () => { chrome = {}; mutation(); } };
}

test('bridge advertises the version and readiness only once after real UI appears', async () => {
  const h = harness();
  assert.equal(h.window.gdVersion, '1.2.3');
  assert.equal(h.calls.length, 0);
  h.ready(); h.ready();
  assert.equal(h.calls.filter(call => call.name === 'gd_app_ready').length, 1);
  h.window.gdFocusStarted('fake-task');
  assert.equal(h.calls.at(-1).name, 'gd_focus_started');
  assert.equal(h.calls.at(-1).args.taskId, 'fake-task');
  await flush();
});

test('update notification is deduplicated and never installs without a click', () => {
  const h = harness();
  h.events.get('gd-update-ready')(); h.events.get('gd-update-ready')();
  assert.equal(h.body.children.length, 1);
  assert.equal(h.calls.length, 0);
  assert.match(h.body.children[0].children[0].textContent, /available/);
  assert.doesNotMatch(h.body.children[0].children[0].textContent, /downloaded|ready/);
});

test('double update click is single-flight; failed install stays visible and permits explicit retry', async () => {
  let reject;
  const h = harness(main, () => new Promise((_, no) => { reject = no; }));
  h.events.get('gd-update-ready')();
  const toast = h.body.children[0];
  const [message, button, dismiss] = toast.children;
  button.click(); button.click(); dismiss.click();
  await flush();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].name, 'gd_quit_and_install');
  assert.equal(h.body.children[0], toast);
  assert.equal(button.disabled, true);
  reject(new Error('private provider diagnostic'));
  await flush();
  assert.equal(button.disabled, false);
  assert.equal(dismiss.disabled, false);
  assert.match(message.textContent, /could not be installed/);
  assert.doesNotMatch(message.textContent, /private provider/);
  button.click(); await flush();
  assert.equal(h.calls.length, 2);
});

test('successful apply acknowledgement keeps controls locked while native restart finishes', async () => {
  const h = harness(); h.events.get('gd-update-ready')();
  const button = h.body.children[0].children[1];
  button.click(); await flush(); button.click(); await flush();
  assert.equal(h.calls.length, 1);
  assert.equal(button.disabled, true);
  assert.equal(button.textContent, 'Restarting…');
});

test('synchronous invocation failure is contained and does not hide the update action', async () => {
  const h = harness(main, () => { throw new Error('blocked'); });
  h.events.get('gd-update-ready')();
  const button = h.body.children[0].children[1];
  button.click(); await flush();
  assert.equal(button.disabled, false);
  assert.equal(h.body.children.length, 1);
});

test('fire-and-forget main and pill calls contain native ACL rejection', async () => {
  const fail = () => Promise.reject(new Error('denied'));
  const mainBridge = harness(main, fail);
  mainBridge.window.gdAppReady(); mainBridge.window.gdLog('test'); mainBridge.window.gdFocusStarted('test');
  const pillBridge = harness(pill, fail);
  pillBridge.window.gdOpenTask('fake'); pillBridge.window.gdResizePill(400, 56);
  pillBridge.window.gdMovePill(2, 3); pillBridge.window.gdSetAnim(200, 'out'); pillBridge.window.gdLog('test');
  await flush();
  assert.equal(mainBridge.calls.length, 3);
  assert.deepEqual(pillBridge.calls.map(call => call.name), [
    'gd_open_task', 'gd_resize_pill', 'gd_move_pill', 'gd_set_anim', 'gd_log',
  ]);
});
