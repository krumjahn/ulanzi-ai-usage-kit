'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const plugin = path.join(root, 'plugin', fs.readdirSync(path.join(root, 'plugin'))[0]);
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('ok - ' + name); }
function load(name, dependencies) {
  const context = {
    module: { exports: {} }, Buffer, URLSearchParams,
    require(id) {
      if (Object.hasOwn(dependencies, id)) return dependencies[id];
      throw new Error('Unexpected dependency or I/O: ' + id);
    },
    setTimeout, clearTimeout, AbortController,
    fetch() { throw new Error('Network forbidden in offline tests'); },
  };
  vm.runInNewContext(fs.readFileSync(path.join(plugin, 'dist', name), 'utf8'), context);
  return context.module.exports;
}
function usage(config = {}, files = {}, calls = []) {
  return load('usage-source.js', {
    fs: {
      existsSync(file) { return Object.hasOwn(files, file); },
      readFileSync(file) { assert.ok(Object.hasOwn(files, file)); return files[file]; },
      writeFileSync() { throw new Error('Unexpected credential write'); },
    },
    os: { homedir: () => '/synthetic-home' }, path,
    child_process: { spawnSync(cmd, args, options) {
      calls.push({ cmd, args, options });
      return { status: 0, stdout: Buffer.from('{"data":{"model_remains":[{"current_interval_total_count":100,"current_interval_remaining_count":64}]}}') };
    } },
    './credentials.js': { section: name => config[name] || {}, geminiClientId: () => '', geminiClientSecret: () => '' },
  });
}
test('MiniMax never reads or forwards Claude credentials', () => {
  const calls = [];
  const source = usage({}, { '/synthetic-home/.claude/settings.json': '{"env":{"ANTHROPIC_AUTH_TOKEN":"synthetic-unrelated"}}' }, calls);
  assert.equal(source.getMinimaxUsage(), 'KEY?');
  assert.equal(calls.length, 0);
});
test('MiniMax keeps credentials out of process arguments', () => {
  const calls = [];
  const source = usage({ minimax: { apiKey: 'synthetic-secret' } }, {}, calls);
  assert.equal(source.getMinimaxUsage(), '64%');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'curl');
  assert.equal(JSON.stringify(calls[0].args), '["--config","-"]');
  assert.ok(calls[0].options.input.includes('Authorization: Bearer synthetic-secret'));
});
test('MiniMax rejects header injection', () => {
  const calls = [];
  assert.equal(usage({ minimax: { apiKey: 'synthetic\nheader' } }, {}, calls).getMinimaxUsage(), 'ERR');
  assert.equal(calls.length, 0);
});
test('Gemini reports absent quota data as unavailable, not full quota', () => {
  const calls = [];
  const files = { '/synthetic-home/.gemini/oauth_creds.json': JSON.stringify({ access_token: 'synthetic-token', expiry_date: Date.now() + 3600000 }) };
  assert.equal(usage({}, files, calls).getGeminiUsage(), 'N/A');
  assert.ok(!JSON.stringify(calls[0].args).includes('synthetic-token'));
});
test('OpenUsage remaining quota resolves from a synthetic snapshot', () => {
  const source = usage();
  source.cache.providers = { codex: { lines: [{ type: 'progress', label: 'weekly', used: 25, limit: 100 }] } };
  assert.equal(source.resolveOpenUsageValue('codex', 'remaining'), '75%');
  assert.equal(source.resolveOpenUsageValue('codex', 'used'), '25%');
});
test('Configuration writes preserve other keys and owner-only permissions', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ulanzi-credentials-test-'));
  try {
    const credentials = load('credentials.js', { fs, path, os: { homedir: () => temporary }, crypto: require('node:crypto') });
    const file = credentials.CONFIG_PATH;
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify({ stripe: { secretKey: 'synthetic-secret' } }));
    credentials.writeField('social', 'handle', 'example');
    assert.equal(JSON.parse(fs.readFileSync(file)).stripe.secretKey, 'synthetic-secret');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    fs.writeFileSync(file, '{invalid');
    assert.throws(() => credentials.writeField('social', 'handle', 'example'));
    assert.equal(fs.readFileSync(file, 'utf8'), '{invalid');
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});
function inspector(address) {
  const events = {}, formEvents = {}, sent = [];
  const field = { name: 'Display', value: 'remaining' };
  const form = { elements: [field], addEventListener(name, fn) { formEvents[name] = fn; } };
  class Socket {
    static OPEN = 1;
    constructor() { this.readyState = 1; }
    addEventListener(name, fn) { events[name] = fn; }
    send(data) { sent.push(JSON.parse(data)); }
  }
  const sandbox = {
    document: { querySelector: selector => selector === '#property-inspector' ? form : { classList: { remove() {} } } },
    location: { pathname: '/property-inspector/claude/inspector.html', search: '?address=' + address + '&port=3906&key=0_0&actionId=test-action' },
    URLSearchParams, WebSocket: Socket,
    setTimeout: fn => { fn(); return 1; }, clearTimeout() {},
    FormData: class { constructor() { return [['Display', field.value]]; } },
  };
  vm.runInNewContext(fs.readFileSync(path.join(plugin, 'property-inspector/inspector.js'), 'utf8'), sandbox);
  return { events, formEvents, sent, field };
}
test('Inspector handshake, incoming settings, and setting persistence', () => {
  const i = inspector('127.0.0.1');
  i.events.open();
  assert.equal(i.sent[0].cmd, 'connected');
  assert.equal(i.sent[0].actionid, 'test-action');
  i.events.message({ data: JSON.stringify({ cmd: 'add', uuid: 'com.ulanzi.ulanzideck.UsageStat.claude', key: '0_0', actionid: 'test-action', param: { Display: 'used', Extra: 'preserved' } }) });
  assert.equal(i.field.value, 'used');
  i.field.value = 'tokens'; i.formEvents.input();
  assert.equal(i.sent[1].cmd, 'paramfromplugin');
  assert.equal(i.sent[1].param.Display, 'tokens');
  assert.equal(i.sent[1].param.Extra, 'preserved');
});
test('Inspector ignores settings for another button and remote hosts', () => {
  const i = inspector('127.0.0.1');
  i.events.message({ data: JSON.stringify({ cmd: 'add', uuid: 'com.ulanzi.ulanzideck.UsageStat.claude', key: 'other', param: { Display: 'used' } }) });
  assert.equal(i.field.value, 'remaining');
  assert.equal(Object.keys(inspector('example.com').events).length, 0);
});
console.log(`${passed} offline JavaScript tests passed; no external I/O performed.`);
