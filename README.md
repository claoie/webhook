# What is this?

The tiniest possible Node.js webhook server. Listens for a signed POST
and runs an arbitrary shell command. Uses only Node built-ins — zero
dependencies to install.

Written for the deploy-hook use case (`git pull && docker compose up -d`
in response to a push), but the command is arbitrary — anything you'd
trigger over an authenticated HTTP call works.

# How to run

Three environment variables:

- `COMMAND` — shell command to run when the webhook fires.
- `SECRET` — bearer token clients must present.
- `PORT` — optional; port to listen on. Defaults to `3002`.

Start it:

```
COMMAND=<your command> SECRET=<your secret> node index.js
```

Trigger it:

```
curl -X POST localhost:3002 \
  -H "Authorization: Bearer <your secret>" \
  -H "Content-Type: application/json" \
  -d '{"sha": "abc123"}'
```

The `Authorization: Bearer` value is hashed to a 32-byte SHA-256 digest
and compared to `SECRET`'s digest in constant time
(`crypto.timingSafeEqual`). The request body is optional — anything you
send gets JSON-parsed (best effort) and logged with the deploy line, so
audit fields like `sha` or `repo` survive.

## Response

The server waits for `COMMAND` to finish and returns the outcome, so
the caller (e.g. a GitHub Actions job) can fail the run on a broken
deploy instead of always seeing `200`.

- Success (exit 0): `200` with `{ ok: true, durationMs, stdout_tail, stderr_tail }`.
- Failure (non-zero exit or killed by signal): `500` with `{ ok: false, exit_code, signal, durationMs, stdout_tail, stderr_tail }`. On a signal kill (including our own timeout SIGKILL), `exit_code` is `null` and `signal` is set — that's how you tell a timeout from a real exit-1.
- Missing or invalid `Authorization`: `401`, no body. The request is still logged (timestamp + remote IP) but no command runs.
- Request body larger than 64 KiB: `413` with `{ ok: false, error: "body too large" }`.
- Second call arriving while an earlier one is still running: `409` with `{ ok: false, error: "already running" }`. Safe to retry once the first one finishes.
- Wrong method: `405` with `Allow: POST`.

Named constants at the top of `index.js` (`TAIL_MAX`, `BODY_MAX`,
`EXEC_MAX_BUFFER`, `DEPLOY_TIMEOUT_MS`) control the caps; edit in one
place. Defaults: 2000-char tails, 64 KiB body, 2 MiB child stdio buffer
per stream, 10-minute deploy timeout.

# Running under pm2

`ecosystem.config.js` at the repo root registers `index.js` with pm2 so
the process is supervised, restarts on crash, and survives host reboots
(if pm2's own systemd unit is installed via `pm2 startup`). Env values
(`APP_NAME`, `COMMAND`, `SECRET`, `PORT`) are read from the shell at
startup — no secrets in the repo.

`COMMAND` is a shell string, so a typical deploy command reads a
`docker-compose.yml` sitting next to it on the host (image tags getting
repushed by the upstream CI is what actually rolls new code):

```
# First-time start (or after `git pull` in an existing checkout)
APP_NAME=deploy \
  COMMAND='sudo docker compose pull && sudo docker compose up -d && sudo docker system prune -a -f' \
  SECRET=$DEPLOY_SECRET \
  PORT=3002 \
  pm2 startOrReload ecosystem.config.js

# Restart in place (picks up new code AND new env)
APP_NAME=deploy \
  COMMAND='...' \
  SECRET=$DEPLOY_SECRET \
  PORT=3002 \
  pm2 restart ecosystem.config.js --update-env
```

Two things worth noting for that example:

- The `docker-compose.yml` and its `.env` live on the host, adjacent to
  wherever pm2 runs the process — the webhook doesn't ship or clone
  them. Set the pm2 process's `cwd` (or `cd` at the start of `COMMAND`)
  to the directory that holds compose.
- One host can run multiple webhook instances by giving each a distinct
  `APP_NAME` + `PORT` (e.g. `APP_NAME=inbox-deploy PORT=3002` alongside
  `APP_NAME=budget-deploy PORT=3003`). `APP_NAME` defaults to `webhook`
  when unset — fine for the single-instance case. `PORT` defaults to
  `3002`.

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
