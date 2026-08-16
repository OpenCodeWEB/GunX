/**
 * Raw WebSocket upgrade test against gunx endpoints (no gun client involved).
 * Uses the `ws` package from gun's dependency tree.
 */
var wsLib = require('ws');
var url = process.argv[2] || 'wss://gunx.pages.dev/gun';
console.log('connecting to', url);
var t0 = Date.now();
var ws = new wsLib(url, { headers: { origin: 'https://gunx.pages.dev' } });
ws.on('open', function () {
  console.log('OPEN after', Date.now() - t0, 'ms — sending gun hello put');
  ws.send(JSON.stringify({ '#': 'abc123', put: { 'rawtest/hello': { _: { '#': 'rawtest/hello', '>': {} }, hello: 'o' } } }));
});
ws.on('message', function (data) {
  console.log('MESSAGE:', String(data));
  ws.close();
});
ws.on('close', function (code, reason) {
  console.log('CLOSE', code, String(reason));
  process.exit(code === 1000 ? 0 : 1);
});
ws.on('error', function (err) {
  console.log('ERROR:', err.message);
  process.exit(1);
});
setTimeout(function () { console.log('TIMEOUT'); process.exit(1) }, 20000);