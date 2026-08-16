const WebSocket = require("ws");
const ws = new WebSocket("wss://gunx.pages.dev/gun");
let step = 0;
const soul = "verify-parent/test-" + Date.now().toString(36);
ws.on("open", () => {
  setTimeout(() => {
    // 1. put a LEAF only (like gun browsers do)
    ws.send(JSON.stringify({ "#": "m1", put: { [soul]: { _: { "#": soul, ">": { v: Date.now() } }, v: 42 } } }));
  }, 400);
});
ws.on("message", (d) => {
  const msg = JSON.parse(String(d));
  console.log(`[${++step}] ${JSON.stringify(msg).slice(0, 500)}`);
  if (step === 1) {
    // 2. get the PARENT — must return the child ref now
    ws.send(JSON.stringify({ "#": "m2", get: { "#": "verify-parent" } }));
  } else if (step === 2) {
    ws.close();
    process.exit(0);
  }
});
setTimeout(() => { console.log("TIMEOUT"); process.exit(1); }, 8000);