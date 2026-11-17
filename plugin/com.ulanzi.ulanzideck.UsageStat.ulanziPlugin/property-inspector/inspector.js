/* Small purpose-built Ulanzi inspector client. No vendor SDK is bundled. */
'use strict';
(() => {
  const form = document.querySelector('#property-inspector');
  const wrapper = document.querySelector('.udpi-wrapper');
  const action = location.pathname.split('/').slice(-2, -1)[0];
  const query = new URLSearchParams(location.search);
  const address = query.get('address') || '127.0.0.1';
  const port = query.get('port') || '3906';
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(address) || !/^\d{1,5}$/.test(port)) return;
  let key = query.get('key') || '';
  let actionid = query.get('actionId') || '';
  const uuid = 'com.ulanzi.ulanzideck.UsageStat.' + action;
  const socket = new WebSocket(`ws://${address}:${port}`);
  let settings = {};
  let pending;
  function send(cmd, extra) {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ cmd, uuid, key, actionid, ...extra }));
  }
  socket.addEventListener('open', () => {
    send('connected', { code: 0 });
    wrapper.classList.remove('hidden');
  });
  socket.addEventListener('message', event => {
    let message;
    try { message = JSON.parse(event.data); } catch (_) { return; }
    if (!message || message.uuid !== uuid) return;
    if (message.code !== undefined && message.cmdType !== 'REQUEST') return;
    if (key && message.key && message.key !== key) return;
    if (actionid && message.actionid && message.actionid !== actionid) return;
    key ||= message.key || '';
    actionid ||= message.actionid || '';
    if (!['add', 'paramfromapp'].includes(message.cmd) || !message.param) return;
    settings = { ...message.param };
    for (const element of form.elements) {
      if (element.name && settings[element.name] !== undefined) element.value = settings[element.name];
    }
  });
  form.addEventListener('input', () => {
    clearTimeout(pending);
    pending = setTimeout(() => {
      settings = { ...settings, ...Object.fromEntries(new FormData(form)) };
      send('paramfromplugin', { param: settings });
    }, 150);
  });
})();
