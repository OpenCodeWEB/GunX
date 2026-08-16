/**
 * Cross-process relay test.
 *   node relay-proc.js reader <soul>  — subscribe, exit 0 when put arrives
 *   node relay-proc.js writer <soul>  — put after 3s
 */
var Gun = require('gun');
var PEER = 'https://gunx.pages.dev/gun';
var MODE = process.argv[2] || 'reader';
var soul = process.argv[3] || ('proc-relay/' + Date.now());
var opts = { peers: [PEER], localStorage: false, radisk: false, file: false, axe: false, multicast: false };

if (MODE === 'reader') {
  var gun = Gun(opts);
  gun.get(soul).on(function (node) {
    if (!node) return;
    console.log('READER GOT:', JSON.stringify(node));
    process.exit(0);
  });
  setTimeout(function () { console.log('READER TIMEOUT'); process.exit(1) }, 20000);
} else {
  var gun = Gun(opts);
  setTimeout(function () {
    console.log('WRITER putting', soul);
    gun.get(soul).put({ val: 'proc-relay-value', at: Date.now() }, function (ack) {
      console.log('WRITER ack:', JSON.stringify(ack));
      setTimeout(function () { process.exit(0) }, 2000);
    });
  }, 3000);
  setTimeout(function () { console.log('WRITER TIMEOUT'); process.exit(1) }, 20000);
}