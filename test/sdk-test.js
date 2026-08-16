/**
 * sdk-test.js — GunX SDK integration test against the live gunx relay.
 *
 *   npm install   (in test/ — gun dependency)
 *   node test/sdk-test.js [relayUrl]
 *
 * Verifies: namespaced write/read through gunx.pages.dev, appKey isolation,
 * refresh() reaching the relay (stats counter grows), and SDK status events.
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const Gun = require("gun");
const GunX = require("../sdk/gunx.js");
const RELAY = process.argv[2] || "https://gunx.pages.dev/gun";

let failures = 0;
function check(name, cond, extra) {
  if (cond) {
    console.log("  PASS " + name);
  } else {
    failures++;
    console.log("  FAIL " + name + (extra ? " — " + extra : ""));
  }
}

(async function main() {
  console.log("GunX SDK test against " + RELAY);
  const gunx = GunX({ appKey: "sdk-test-" + Date.now().toString(36), refreshMs: 0, peers: [RELAY] });

  // 1. status events
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 20000);
    gunx.on("status", (s) => {
      if (s.status === "connected") {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  check("relay connection (status event)", gunx._status === "connected", "status=" + gunx._status);

  // 2. namespaced write + read
  const soul = "hello";
  const value = { msg: "gunx sdk works", n: Math.floor(Math.random() * 1e6) };
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("write timeout")), 8000);
    gunx.put(soul, value, (ack) => {
      if (ack.err) return reject(ack.err);
      clearTimeout(t);
      resolve();
    });
  });
  check("namespaced put ack", true);

  const read = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 8000);
    gunx.get(soul).once((data) => {
      clearTimeout(t);
      resolve(data);
    });
  });
  check("namespaced read-back", !!read && read.msg === value.msg && read.n === value.n, JSON.stringify(read));

  // 3. appKey isolation: raw gun (no namespace) must NOT see the value
  const raw = Gun({ peers: [RELAY], axe: false, multicast: false, localStorage: false, radisk: false, file: false });
  const rawRead = await new Promise((resolve) => {
    const t = setTimeout(() => resolve({ timeout: true }), 6000);
    raw.get(soul).once((data) => { clearTimeout(t); resolve(data); });
  });
  check("appKey isolation (unprefixed soul empty)", !rawRead || Object.keys(rawRead).length === 0 || rawRead.timeout, JSON.stringify(rawRead));

  // 4. refresh() sends plain-soul GETs (relay stats counter grows)
  const statsUrl = RELAY.replace(/\/gun$/, "") + "/api/stats";
  const statsBefore = await (await fetch(statsUrl)).json();
  const tracked = Object.keys(gunx.trackedSouls).length;
  gunx.trackedSouls[gunx.ns("hello")] = 1; // ensure tracked
  gunx.refresh();
  await new Promise((r) => setTimeout(r, 2500));
  const statsAfter = await (await fetch(statsUrl)).json();
  check("refresh() reaches relay", statsAfter.messagesProcessed > statsBefore.messagesProcessed,
    statsBefore.messagesProcessed + " -> " + statsAfter.messagesProcessed);
  check("tracked souls registered", tracked >= 1, "tracked=" + tracked);

  // 5. cross-instance relay: a second SDK client sees the put (relay broadcast)
  const gunx2 = GunX({ appKey: gunx.appKey, refreshMs: 0, peers: [RELAY] });
  const relayed = await new Promise((resolve) => {
    const t = setTimeout(() => resolve({ timeout: true }), 12000);
    gunx2.get(soul).once((data) => {
      if (data && data.n === value.n) { clearTimeout(t); resolve(data); }
    });
  });
  check("second client converges via relay", !!relayed && relayed.msg === value.msg, JSON.stringify(relayed));

  gunx.destroy();
  gunx2.destroy();
  console.log(failures ? "\n" + failures + " FAILURES" : "\nALL PASS");
  // Grace period so gun's WebSockets can close before exit (avoids libuv assert on Windows).
  setTimeout(() => process.exit(failures ? 1 : 0), 1500);
})().catch((e) => {
  console.error("ERROR", e.message);
  setTimeout(() => process.exit(2), 1500);
});
