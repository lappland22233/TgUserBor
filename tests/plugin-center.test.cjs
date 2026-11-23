'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { handleApiRoute } = require('../dist/gui/api');

test('plugin center honors manifest defaults and isolated instance overrides through config and reinstall', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-center-'));
  const pluginsDir = path.join(root, 'plugins');
  const pluginPath = path.join(pluginsDir, 'quiet-folder', 'plugin.json');
  fs.mkdirSync(path.dirname(pluginPath), { recursive: true });
  fs.writeFileSync(pluginPath, JSON.stringify({ name: 'quiet', version: '1', defaultEnabled: false }));

  const instances = new Map(['first', 'second'].map((id) => {
    const info = { status: 'STOPPED' };
    return [id, {
      config: { pluginDir: pluginsDir, dbPath: path.join(root, id, 'bot.sqlite') },
      getInfo: () => info,
    }];
  }));
  const actions = [];
  const manager = {
    getInstance: (id) => instances.get(id),
    async broadcastPluginAction(action, name, dir) {
      actions.push({ action, name, dir });
    },
  };
  const server = http.createServer((req, res) => handleApiRoute(req, res, manager, pluginsDir));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/api`;
    const request = (route, method = 'GET', data) => fetch(base + route, {
      method,
      headers: { 'content-type': 'application/json' },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    const plugin = async (id, name = 'quiet') => {
      const res = await request(`/plugins?instance=${id}`);
      assert.equal(res.status, 200);
      return (await res.json()).find((plugin) => plugin.name === name);
    };
    const quietConfig = '/plugins/quiet/config?instance=first';

    assert.equal((await plugin('first')).defaultEnabled, false);
    assert.equal((await plugin('second')).enabled, false);
    assert.equal((await request(quietConfig, 'PUT', { config: { greeting: 'hi' } })).status, 200);
    assert.equal((await plugin('first')).enabled, false);
    assert.deepEqual(await (await request(quietConfig)).json(), { config: { greeting: 'hi' } });

    fs.writeFileSync(pluginPath, JSON.stringify({ name: 'quiet', version: '1' }));
    assert.equal((await plugin('first')).enabled, true);
    assert.equal((await request('/instances/first/plugins/quiet/disable', 'POST')).status, 200);
    assert.equal((await request(quietConfig, 'PUT', { config: { greeting: 'hello' } })).status, 200);
    assert.equal((await plugin('first')).enabled, false);
    assert.equal((await plugin('second')).enabled, true);
    assert.equal((await request('/instances/first/plugins/quiet/reload', 'POST')).status, 409);
    const firstInfo = instances.get('first').getInfo();
    Object.assign(firstInfo, { status: 'ERROR', pid: 123 });
    assert.equal((await request('/instances/first/plugins/quiet/enable', 'POST')).status, 409);
    assert.equal((await plugin('first')).enabled, false);
    assert.equal((await request('/plugins?instance=missing')).status, 404);

    assert.equal((await request('/plugins/quiet', 'DELETE')).status, 200);
    const created = await request('/plugins', 'POST', { name: 'quiet', description: "It's quiet." });
    assert.equal(created.status, 201);
    assert.equal((await created.json()).plugin.defaultEnabled, true);
    const entry = require(path.join(pluginsDir, 'quiet', 'index.js'));
    assert.equal(entry.manifest.description, "It's quiet.");
    assert.equal((await plugin('first')).enabled, false);
    assert.equal((await plugin('second')).enabled, true);
    assert.deepEqual(actions, [
      { action: 'unload', name: 'quiet', dir: pluginsDir },
      { action: 'reload', name: 'quiet', dir: pluginsDir },
    ]);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('plugin center renders per-instance switches and ignores the prior instance response', async () => {
  const app = fs.readFileSync(path.join(__dirname, '../src/gui/web/app.js'), 'utf8');
  const load = app.slice(app.indexOf('let pluginListRequestId'), app.indexOf('// Rendering Instances Cards'));
  const render = app.slice(app.indexOf('function renderPlugins()'), app.indexOf('// Plugin Actions'));
  const state = {
    plugins: [],
    selectedInstanceForPlugins: 'first',
    instances: ['first', 'second'].map((id) => ({ config: { id }, status: 'STOPPED' })),
  };
  const el = { dashPluginsCount: {}, pluginSearchInput: { value: '' }, pluginsGrid: {} };
  const requests = [];
  const context = vm.createContext({
    state, el,
    api(url) { return new Promise((resolve) => requests.push({ url, resolve })); },
    escapeHtml: String,
    inlineJsArg: JSON.stringify,
  });
  vm.runInContext(load + render, context);

  const first = context.loadPlugins();
  state.selectedInstanceForPlugins = 'second';
  const second = context.loadPlugins();
  assert.deepEqual(requests.map(({ url }) => url), ['/api/plugins?instance=first', '/api/plugins?instance=second']);

  requests[1].resolve([{ name: 'quiet', available: true, enabled: true }]);
  await second;
  assert.match(el.pluginsGrid.innerHTML, /<input[^>]* checked /);
  requests[0].resolve([{ name: 'quiet', available: true, enabled: false }]);
  await first;
  assert.match(el.pluginsGrid.innerHTML, /<input[^>]* checked /);

  const update = context.loadPlugins();
  requests[2].resolve([{ name: 'quiet', available: true, enabled: false }]);
  await update;
  assert.doesNotMatch(el.pluginsGrid.innerHTML, /<input[^>]* checked /);
});
