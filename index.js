const http = require("http");
const { exec } = require("child_process");
const { timingSafeEqual } = require("crypto");
const { promisify } = require("util");

const execAsync = promisify(exec);
const { COMMAND, SECRET, PORT } = process.env;

if (!COMMAND || !SECRET) {
  console.error("COMMAND and SECRET env vars are required");
  process.exit(1);
}

const SECRET_BUF = Buffer.from(SECRET);

// Serialize invocations. A concurrent second POST would race COMMAND
// against itself (git pull + docker compose up -d don't lock each
// other). Return 409 and let the caller retry — GitHub Actions'
// `concurrency.group` upstream already queues, so this is a
// belt-and-suspenders guard.
let isRunning = false;

function isAuthorized(req) {
  const header = req.headers["authorization"];
  if (typeof header !== "string") return false;
  const match = /^Bearer\s+(.+)$/.exec(header);
  if (!match) return false;
  const provided = Buffer.from(match[1]);
  // `timingSafeEqual` requires equal-length inputs to run in constant
  // time. Reject-fast on length mismatch has a tiny timing side channel
  // (leaks the secret length), which is acceptable given the secret is
  // fixed-length in practice.
  if (provided.length !== SECRET_BUF.length) return false;
  return timingSafeEqual(provided, SECRET_BUF);
}

http
  .createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }

    if (!isAuthorized(req)) {
      console.warn(
        new Date().toISOString(),
        "unauthorized request from",
        req.socket.remoteAddress,
      );
      res.writeHead(401).end();
      return;
    }

    if (isRunning) {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "already running" }));
      return;
    }

    // Body is not load-bearing for auth; read only so the caller can
    // pass extra context (sha, repo) that ends up in the log line.
    const chunks = [];
    try {
      for await (const chunk of req) chunks.push(chunk);
    } catch {
      /* client disconnected mid-body — treat as empty */
    }
    const bodyRaw = Buffer.concat(chunks).toString();
    let body = null;
    try {
      body = bodyRaw ? JSON.parse(bodyRaw) : null;
    } catch {
      /* non-JSON body is fine — leave `body` null */
    }

    isRunning = true;
    const startedAt = Date.now();
    try {
      // Capture stdout + stderr so the HTTP response can surface why a
      // deploy failed to the caller (GitHub Actions), instead of always
      // returning 200 fire-and-forget.
      const { stdout, stderr } = await execAsync(COMMAND, {
        maxBuffer: 10 * 1024 * 1024,
      });
      const durationMs = Date.now() - startedAt;
      console.log(
        new Date().toISOString(),
        "deploy OK",
        JSON.stringify({ durationMs, body }),
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          durationMs,
          stdout_tail: stdout.slice(-2000),
          stderr_tail: stderr.slice(-2000),
        }),
      );
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const exit_code = typeof error.code === "number" ? error.code : 1;
      const stderr_tail = String(error.stderr || error.message || "").slice(-2000);
      const stdout_tail = String(error.stdout || "").slice(-2000);
      console.error(
        new Date().toISOString(),
        "deploy FAILED",
        JSON.stringify({ durationMs, exit_code, stderr_tail }),
      );
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: false,
          exit_code,
          durationMs,
          stdout_tail,
          stderr_tail,
        }),
      );
    } finally {
      isRunning = false;
    }
  })
  .listen(PORT || 3002, () => {
    console.log(
      new Date().toISOString(),
      `webhook listening on :${PORT || 3002}`,
    );
  });
