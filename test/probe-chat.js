const WebSocket = require("ws");
const ws = new WebSocket("wss://gunx.pages.dev/gun");
let step = 0;
ws.on("open", () => {
  setTimeout(() => {
    ws.send(JSON.stringify({ "#": "q1", get: { "#": "gunx-playground/chat" } }));
  }, 400);
});
ws.on("message", (d) => {
  const msg = JSON.parse(String(d));
  console.log(`[${++step}] ${JSON.stringify(msg).slice(0, 600)}`);
  if (step === 1) {
    ws.send(JSON.stringify({ "#": "q2", get: { "#": "gunx-playground" } }));
  } else if (step === 2) {
    ws.close();
    process.exit(0);
  }
});
setTimeout(() => { console.log("TIMEOUT"); process.exit(1); }, 8000);