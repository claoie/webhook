# What is this script?

It's a tiniest Node.js server that listens to a request to trigger an arbitrary command. It uses built in packages only and requires not even a single package to download!

This script is written for the purpose to be useful to put up a server that listens to webhook call and trigger the deployment (for example, `docker pull && docker up`) but you can use it for any kind of purpose. :)

# How to use?

3 environment variables used

- COMMAND: Terminal command that you would like to run when the webhook is called.
- SECRET: Your secret key to validate the request.
- PORT: (optional) Port number to run the server (defaults to 3002).

Run the Node.js server for example:

```
COMMAND=<your command> SECRET=<your secret> node index.js
```

Trigger the webhook by sending a POST request for example:

```
curl -X POST localhost:3002 \
  -H "Authorization: Bearer my-secret" \
  -H "Content-Type: application/json" \
  -d '{"sha": "abc123"}'
```

The `Authorization: Bearer` header is compared with the `SECRET` env var in constant time (`crypto.timingSafeEqual`). The request body is optional and just gets logged alongside the deploy — pass anything useful for auditing (`sha`, `repo`, whatever). Any non-`POST` method returns `405`.

## Response

The server awaits `COMMAND` to completion and returns the outcome so the caller (e.g. a GitHub Actions job) can fail the run on a broken deploy instead of always seeing `200`.

- Success (exit 0): `200` with `{ ok: true, durationMs, stdout_tail, stderr_tail }`.
- Failure (non-zero exit or killed by signal): `500` with `{ ok: false, exit_code, signal, durationMs, stdout_tail, stderr_tail }`. On a signal kill (including our own timeout SIGKILL), `exit_code` is `null` and `signal` is set — that's how you tell a timeout from a real exit-1.
- Missing/invalid `Authorization`: `401`, no body; the request is logged (timestamp + remote IP) but no command runs.
- Request body larger than 64 KiB: `413` with `{ ok: false, error: "body too large" }`.
- Second call arriving while an earlier one is still running: `409` with `{ ok: false, error: "already running" }` — safe to retry after the running one finishes.
- Wrong method: `405` with `Allow: POST`.

Named constants at the top of `index.js` (`TAIL_MAX`, `BODY_MAX`, `EXEC_MAX_BUFFER`, `DEPLOY_TIMEOUT_MS`) control the caps; edit in one place. Defaults: 2000-char tails, 64 KiB body, 2 MiB child stdio buffer per stream, 10-minute deploy timeout.
