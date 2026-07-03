const http = require("http");
const { exec } = require("child_process");
const { timingSafeEqual, createHash } = require("crypto");
const { promisify } = require("util");

const execAsync = promisify(exec);
const { COMMAND, SECRET, PORT } = process.env;

if (!COMMAND || !SECRET) {
  console.error("COMMAND and SECRET env vars are required");
  process.exit(1);
}

// Hash both provided secret and env secret to a fixed 32-byte digest
// before `timingSafeEqual`, so the comparison length is uniform and
// the small "reject on length mismatch" side channel goes away.
const SECRET_HASH = createHash("sha256").update(SECRET).digest();

// Response size caps.
const TAIL_MAX = 2000; // stdout/stderr characters surfaced per response
const BODY_MAX = 64 * 1024; // request body bytes accepted
const EXEC_MAX_BUFFER = 2 * 1024 * 1024; // child stdio buffer per stream
const DEPLOY_TIMEOUT_MS = 10 * 60 * 1000; // hard kill so a hung COMMAND
// can't wedge `isRunning=true` forever and permanently 409 subsequent
// requests. 10 min covers realistic docker-compose pull+up windows;
// bump if the deploy legitimately takes longer.

// Serialize invocations. A concurrent second POST would race COMMAND
// against itself (git pull + docker compose up -d don't lock each
// other). Return 409 and let the caller retry — GitHub Actions'
// `concurrency.group` upstream already queues, so this is a
// belt-and-suspenders guard.
let isRunning = false;

function isAuthorized(req) {
  const raw = req.headers["authorization"];
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (typeof header !== "string") return false;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return false;
  const providedHash = createHash("sha256").update(match[1]).digest();
  return timingSafeEqual(providedHash, SECRET_HASH);
}

http
  .createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" }).end();
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

    // Flip the guard synchronously right after the auth check, BEFORE
    // any await. If we waited until after the body-read, two concurrent
    // authorized POSTs would both pass the `if (isRunning)` check
    // during each other's `for await` yield and both call
    // `execAsync(COMMAND)`. The `finally` inside the async body still
    // resets the flag on any exit path.
    if (isRunning) {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "already running" }));
      return;
    }
    isRunning = true;

    const startedAt = Date.now();
    try {
      // Body is not load-bearing for auth; read only so the caller can
      // pass extra context (sha, repo) that ends up in the log line.
      // Cap at BODY_MAX so a misbehaving authorized client can't stream
      // arbitrary MiB through us.
      const chunks = [];
      let total = 0;
      let overflow = false;
      try {
        for await (const chunk of req) {
          total += chunk.length;
          if (total > BODY_MAX) {
            overflow = true;
            break;
          }
          chunks.push(chunk);
        }
      } catch {
        /* client disconnected mid-body — treat as empty */
      }
      if (overflow) {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "body too large" }));
        return;
      }
      const bodyRaw = Buffer.concat(chunks).toString();
      let body = null;
      try {
        body = bodyRaw ? JSON.parse(bodyRaw) : null;
      } catch {
        /* non-JSON body is fine — leave `body` null */
      }

      // Capture stdout + stderr so the HTTP response can surface why a
      // deploy failed to the caller (GitHub Actions), instead of always
      // returning 200 fire-and-forget. `timeout + SIGKILL` protects
      // against a wedged COMMAND holding the guard forever.
      const { stdout, stderr } = await execAsync(COMMAND, {
        maxBuffer: EXEC_MAX_BUFFER,
        timeout: DEPLOY_TIMEOUT_MS,
        killSignal: "SIGKILL",
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
          stdout_tail: stdout.slice(-TAIL_MAX),
          stderr_tail: stderr.slice(-TAIL_MAX),
        }),
      );
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      // `error.code` is a number on normal non-zero exit; `null` when
      // the child was killed by a signal (our timeout SIGKILL, or an
      // external kill). `signal` differentiates the two so the caller
      // (e.g. GH Actions retry logic) can tell timeout from exit-1.
      const exit_code = typeof error.code === "number" ? error.code : null;
      const signal = error.signal || null;
      const stderr_tail = String(error.stderr || error.message || "").slice(-TAIL_MAX);
      const stdout_tail = String(error.stdout || "").slice(-TAIL_MAX);
      console.error(
        new Date().toISOString(),
        "deploy FAILED",
        JSON.stringify({ durationMs, exit_code, signal, stderr_tail }),
      );
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: false,
          exit_code,
          signal,
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
