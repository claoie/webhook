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

# Running under pm2

`ecosystem.config.js` at the repo root registers `index.js` with pm2 so
the process is supervised, restarts on crash, and survives host reboots
(if pm2's own systemd unit is installed via `pm2 startup`). Env values
(`APP_NAME`, `COMMAND`, `SECRET`, `PORT`) are read from the shell at
startup — no secrets in the repo.

One host can run multiple webhook instances with distinct deploy
targets by giving each one a distinct `APP_NAME`:

```
# First-time start (or after `git pull` in an existing checkout)
APP_NAME=inbox-deploy \
  COMMAND='cd ~/inbox && git pull && docker compose up -d --build' \
  SECRET=$INBOX_DEPLOY_SECRET \
  PORT=3002 \
  pm2 startOrReload ecosystem.config.js

# Restart in place (picks up new code AND new env)
APP_NAME=inbox-deploy \
  COMMAND='...' \
  SECRET=$INBOX_DEPLOY_SECRET \
  PORT=3002 \
  pm2 restart ecosystem.config.js --update-env

# A second, independent instance
APP_NAME=budget-deploy \
  COMMAND='cd ~/budget && git pull && docker compose up -d --build' \
  SECRET=$BUDGET_DEPLOY_SECRET \
  PORT=3003 \
  pm2 startOrReload ecosystem.config.js
```

`APP_NAME` defaults to `webhook` when unset — fine for the single-
instance case. `PORT` defaults to `3002`.

Everyday commands:

```
pm2 status                     # list processes
pm2 logs <APP_NAME>            # tail combined stdout/stderr
pm2 restart <APP_NAME>         # bounce without re-reading ecosystem
pm2 stop <APP_NAME>            # stop but keep in the process list
pm2 delete <APP_NAME>          # remove from the process list
pm2 save                       # persist the current list so `pm2 resurrect` re-hydrates it after reboot
```

Use `pm2 restart <name> --update-env` when the env changed (rotated
secret, new `COMMAND`); a plain `pm2 restart <name>` reuses the env
pm2 recorded at `startOrReload` time.
