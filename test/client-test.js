/**
 * gunx.pages.dev smoke test — real gun client (0.2020.1241, same as the portal).
 *
 * Usage:
 *   node client-test.js write   — put a node, ack, read back, exit 0
 *   node client-test.js read    — read the node written by a previous run (persistence)
 *   node client-test.js relay   — two clients: B subscribes, A puts, B must receive via relay
 */
var Gun = require('gun');
var PEER = process.env.GUNX_PEER || 'https://gunx.pages.dev/gun';
var MODE = process.argv[2] || 'write';
var SOUL = 'gunx-test/smoke';
var opts = {
  peers: [PEER],
  localStorage: false,
  radisk: false,
  file: false,
  axe: false,
  multicast: false,
};

function die(code, msg) {
  console.log(msg || '');
  process.exit(code);
}

if (MODE === 'write') {
  var gun = Gun(opts);
  var val = 'v' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  gun.get(SOUL).put({ val: val, at: Date.now() }, function (ack) {
    console.log('WRITE ack:', JSON.stringify(ack));
    gun.get(SOUL).once(function (node, key) {
      console.log('WRITE readback:', key, JSON.stringify(node));
      console.log('compare:', JSON.stringify(node && node.val), '===', JSON.stringify(val), '->', node && node.val === val);
      die(node && node.val === val ? 0 : 2, node ? 'MISMATCH' : 'NO READBACK');
    });
  });
  setTimeout(function () { die(1, 'WRITE timeout') }, 25000);
} else if (MODE === 'read') {
  var gun = Gun(opts);
  gun.get(SOUL).once(function (node, key) {
    console.log('READ:', key, JSON.stringify(node));
    die(node && node.val ? 0 : 2, node ? '' : 'NODE MISSING');
  });
  setTimeout(function () { die(1, 'READ timeout') }, 25000);
} else if (MODE === 'relay') {
  var gunA = Gun(opts);
  var gunB = Gun(opts);
  var rSoul = 'gunx-test/relay-' + Date.now();
  var got = false;
  gunB.get(rSoul).on(function (node, key) {
    if (!node) return;
    console.log('RELAY B received:', key, JSON.stringify(node));
    got = true;
    die(0, 'RELAY OK');
  });
  setTimeout(function () {
    if (got) return;
    var val = 'r' + Date.now();
    console.log('RELAY A putting', val, 'to', rSoul);
    gunA.get(rSoul).put({ val: val }, function (ack) {
      console.log('RELAY A ack:', JSON.stringify(ack));
    });
  }, 3000);
  setTimeout(function () { if (!got) die(1, 'RELAY timeout') }, 25000);
} else {
  die(1, 'unknown mode');
}