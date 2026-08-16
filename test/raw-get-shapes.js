// Raw WS probe: what does gunx DO peer reply to different GET shapes?
const WebSocket = require("ws");
const ws = new WebSocket("wss://gunx.pages.dev/gun");
let step = 0;
ws.on("open", () => {
  setTimeout(() => {
    // 1. plain soul get
    ws.send(JSON.stringify({ "#": "p1", get: { "#": "community_posts" } }));
  }, 500);
});
ws.on("message", (d) => {
  const msg = JSON.parse(String(d));
  console.log(`[${++step}] REPLY ${JSON.stringify(msg).slice(0, 500)}`);
  if (step === 1) {
    // 2. hash-check get for a known key with a WRONG hash (force push)
    const wrongHash = String.hash ? String.hash("zzz") : "wrong-hash-123";
    ws.send(JSON.stringify({ "#": "p2", "##": wrongHash, get: { "#": "community_posts", ".": "tesrt" } }));
  } else if (step === 2) {
    // 3. specific-key get for a MISSING key
    ws.send(JSON.stringify({ "#": "p3", get: { "#": "community_posts", ".": "no-such-key" } }));
  } else {
    ws.close();
    process.exit(0);
  }
});
ws.on("error", (e) => { console.log("ERR", e.message); process.exit(1); });
setTimeout(() => { console.log("TIMEOUT"); process.exit(2); }, 10000);