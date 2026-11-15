// Token sync test: real WebCrypto in headless Chromium, GitHub API mocked with request interception.
// usage: node tests/token_sync.test.js <site_dir>
// The site copy's login hash is swapped for a throwaway test credential (the real one is never needed or changed).
const { chromium } = require("playwright");
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");

const dir = process.argv[2];
const U = "tester", P = "test-pass-123", TOKEN = "github_pat_TESTTOKEN_abc123";
const app = fs.readFileSync(path.join(dir, "app.js"), "utf8");
const salt = /var AUTH_SALT = "([^"]+)"/.exec(app)[1];
const testHash = crypto.createHash("sha256").update(salt + U + "|" + P).digest("hex");
const patched = app.replace(/var AUTH_HASH = "[0-9a-f]+"/, 'var AUTH_HASH = "' + testHash + '"');

let remote = null, puts = [], deletes = 0, sha = 0;
function serve() {
  return new Promise((res) => {
    const srv = http.createServer((q, s) => {
      const u = q.url.split("?")[0];
      if (u === "/app.js") { s.writeHead(200, { "Content-Type": "text/javascript" }); return s.end(patched); }
      let f = path.join(dir, decodeURIComponent(u)); if (f.endsWith("/")) f += "index.html";
      fs.readFile(f, (e, d) => { if (e) { s.writeHead(404); s.end(); } else { s.writeHead(200, { "Content-Type": { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" }[path.extname(f)] || "application/octet-stream" }); s.end(d); } });
    }).listen(0, () => res({ srv, url: "http://127.0.0.1:" + srv.address().port + "/" }));
  });
}
async function mock(ctx) {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "GET,PUT,DELETE,POST" };
  await ctx.route(/https:\/\/(api\.github\.com|raw\.githubusercontent\.com)\/.*/, async (route) => {
    const r = route.request(), url = new URL(r.url()), m = r.method();
    if (m === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const auth = r.headers()["authorization"] || "";
    const json = (st, b) => route.fulfill({ status: st, headers: { ...cors, "Content-Type": "application/json" }, body: JSON.stringify(b) });
    if (url.pathname.endsWith("/config/token.enc.json")) {
      const raw = /raw\+json/.test(r.headers()["accept"] || "") || url.host.startsWith("raw.");
      if (m === "GET") { if (!remote) return json(404, { message: "Not Found" }); return raw ? json(200, remote) : json(200, { sha: "sha" + sha, content: Buffer.from(JSON.stringify(remote)).toString("base64") }); }
      if (auth !== "Bearer " + TOKEN) return json(401, { message: "Bad credentials" });
      const body = JSON.parse(r.postData() || "{}");
      if (m === "PUT") { if (remote && body.sha !== "sha" + sha) return json(409, { message: "sha mismatch" }); puts.push(body); remote = JSON.parse(Buffer.from(body.content, "base64").toString()); sha++; return json(200, { content: { sha: "sha" + sha } }); }
      if (m === "DELETE") { if (body.sha !== "sha" + sha) return json(409, { message: "sha" }); deletes++; remote = null; return json(200, {}); }
    }
    if (/^\/repos\/negin1100mohammadi\/social-panel\/?$/.test(url.pathname)) return auth === "Bearer " + TOKEN ? json(200, { full_name: "negin1100mohammadi/social-panel", permissions: { push: true } }) : json(401, { message: "Bad credentials" });
    if (url.pathname.endsWith("/actions/workflows")) return json(200, { workflows: [] });
    return json(404, { message: "Not Found" });
  });
}
async function decryptNode(obj, pw) {
  const key = crypto.pbkdf2Sync(pw, Buffer.from(obj.salt, "base64"), 310000, 32, "sha256");
  const ct = Buffer.from(obj.ct, "base64"), iv = Buffer.from(obj.iv, "base64");
  const d = crypto.createDecipheriv("aes-256-gcm", key, iv); d.setAuthTag(ct.subarray(ct.length - 16));
  return Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]).toString();
}

(async () => {
  const { srv, url } = await serve();
  const browser = await chromium.launch();
  let checks = 0; const fails = []; const ok = (c, m) => { checks++; if (!c) fails.push(m); };
  async function device(preAuthed) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, serviceWorkers: "block" });
    await mock(ctx);
    if (preAuthed) await ctx.addInitScript((h) => { if (!sessionStorage.getItem("x")) { localStorage.setItem("sp_auth", h); sessionStorage.setItem("x", "1"); } }, testHash);
    const page = await ctx.newPage(); page.on("pageerror", (e) => fails.push("pageerror " + e));
    await page.goto(url + "#/"); return { ctx, page };
  }
  async function login(page) {
    await page.waitForSelector("#lf"); await page.fill("#u", U); await page.fill("#p", P); await page.click("#lf button.go");
    await page.waitForSelector(".boxes");
  }
  const ls = (page, k) => page.evaluate((k) => localStorage.getItem(k), k);

  // device A: log in, paste token, sync
  const A = await device(false); await login(A.page);
  await A.page.evaluate(() => { location.hash = "#/settings"; });
  await A.page.waitForSelector("#gh-token[name='gh-token']");
  ok(await A.page.$("#sync-user") === null, "A: password fields should be hidden when login password is in this session");
  ok((await A.page.getAttribute("#token-status", "data-state")) === "none", "A: status should be 'none' before token");
  await A.page.fill("#gh-token", TOKEN);
  await A.page.click("#sync-token");
  await A.page.waitForSelector("#sync-msg[data-state='ok'], #sync-msg[data-state='error']", { timeout: 20000 });
  ok((await A.page.getAttribute("#sync-msg", "data-state")) === "ok", "A: sync failed: " + await A.page.textContent("#sync-msg"));
  ok(await ls(A.page, "sp_gh_token") === TOKEN, "A: token not stored locally");
  await A.page.waitForSelector("#token-status[data-state='connected']", { timeout: 10000 }).catch(() => {});
  ok((await A.page.getAttribute("#token-status", "data-state")) === "connected", "A: token status not connected");
  ok(puts.length === 1, "A: expected 1 PUT, got " + puts.length);
  const putBody = puts[0] ? Buffer.from(puts[0].content, "base64").toString() : "";
  ok(!putBody.includes(TOKEN) && !putBody.includes(P), "ciphertext file leaks token or password");
  ok(remote && remote.v === 1 && Buffer.from(remote.salt, "base64").length === 16 && Buffer.from(remote.iv, "base64").length === 12 && remote.ct && !isNaN(Date.parse(remote.created_at)), "bad file format " + JSON.stringify(remote));
  ok(JSON.stringify(Object.keys(remote || {}).sort()) === JSON.stringify(["created_at", "ct", "iv", "salt", "v"]), "file keys " + Object.keys(remote || {}));
  ok(remote && (await decryptNode(remote, P)) === TOKEN, "node could not decrypt with PBKDF2-SHA256/310000 + AES-256-GCM");
  const allLs = await A.page.evaluate(() => JSON.stringify(localStorage));
  ok(!allLs.includes(P), "password found in localStorage");
  ok((await A.page.evaluate(() => sessionStorage.getItem("sp_pw"))) === P, "password not kept in sessionStorage");

  // device B: fresh login -> token arrives automatically
  const B = await device(false); await login(B.page);
  await B.page.waitForFunction(() => localStorage.getItem("sp_gh_token"), null, { timeout: 20000 }).catch(() => {});
  ok(await ls(B.page, "sp_gh_token") === TOKEN, "B: token not synced on login");
  ok(/توکن همگام شد/.test(await B.page.evaluate(() => document.body.innerText)), "B: no 'توکن همگام شد' note");

  // device C: already logged in (no password in this session) -> banner -> settings -> enter password -> pull
  const C = await device(true);
  await C.page.waitForSelector("#sync-banner", { timeout: 15000 }).catch(() => {});
  ok(!!(await C.page.$("#sync-banner")), "C: no sync banner on home");
  await C.page.evaluate(() => { location.hash = "#/settings"; }); await C.page.waitForSelector("#sync-pw");
  await C.page.fill("#sync-user", U); await C.page.fill("#sync-pw", "wrong");
  await C.page.click("#pull-token"); await C.page.waitForSelector("#sync-msg[data-state='error']", { timeout: 10000 }).catch(() => {});
  ok((await C.page.getAttribute("#sync-msg", "data-state")) === "error" && !(await ls(C.page, "sp_gh_token")), "C: wrong password not rejected");
  await C.page.fill("#sync-pw", P); await C.page.click("#pull-token");
  await C.page.waitForFunction(() => localStorage.getItem("sp_gh_token"), null, { timeout: 20000 }).catch(() => {});
  ok(await ls(C.page, "sp_gh_token") === TOKEN, "C: token not pulled with password");

  // A: re-sync (file exists -> PUT with sha), then delete from all devices
  await A.page.click("#sync-token"); await A.page.waitForSelector("#sync-msg[data-state='ok']", { timeout: 20000 }).catch(() => {});
  ok(puts.length === 2 && puts[1].sha === "sha1", "A: re-sync should update existing file with its sha");
  await A.page.click("#del-token-all"); await A.page.click("#del-token-all");
  await A.page.waitForFunction(() => !localStorage.getItem("sp_gh_token"), null, { timeout: 15000 }).catch(() => {});
  ok(deletes === 1 && remote === null, "A: file not deleted");
  ok(!(await ls(A.page, "sp_gh_token")), "A: local token not removed");
  // B opens the panel again -> synced token removed there too
  await B.page.reload(); await B.page.waitForFunction(() => !localStorage.getItem("sp_gh_token"), null, { timeout: 15000 }).catch(() => {});
  ok(!(await ls(B.page, "sp_gh_token")), "B: token not removed after delete-all");

  await browser.close(); srv.close();
  console.log(`${checks} checks, ${fails.length} failed`); fails.forEach((f) => console.log("FAIL " + f));
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
