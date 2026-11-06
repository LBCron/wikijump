# Local Docker stack — agent notes

Short index of **local dev** behavior that is already documented elsewhere but often misread when automating or debugging **install/local** (`deploy.py`, compose project **`wikijump`**). Full procedures stay in the linked files.

## Environment and entrypoint

| Topic | Where it is documented |
|-------|-------------------------|
| `DEEPWELL_RPC_TOKEN` must be **64 lowercase hex** chars in `install/local/.env` (copy from `.env.example`); required for compose interpolation | `install/local/README.md` |
| Primary command: `install/local/deploy.py` and compose project name **`wikijump`** | `docs/development.md` |
| Optional lower-memory Framerail: `FRAMERAIL_MODE=built` | `install/local/README.md` |

**Easy mistake:** Leaving `DEEPWELL_RPC_TOKEN=` empty — compose fails during interpolation with errors naming `DEEPWELL_RPC_TOKEN`. Fix is in `install/local/README.md` (`openssl rand -hex 32`), not a new variable.

## Networking and HTTP checks

| Topic | Where it is documented |
|-------|-------------------------|
| Local wiki HTTPS on **127.0.0.1:18443**, hosts `*.wikijump.dev.localhost` / `*.wjfiles.dev.localhost`, vs standing on **443** | `docs/development.md` |
| **Host-sensitive** URLs (different subdomain ⇒ different site) | `docs/development.md` ("Making Web Requests") |
| Framerail HTML requests need **`Accept: text/html`** | `docs/development.md` ("Making Web Requests") |
| Trusting Caddy’s local CA (`-k` vs trust store) | `install/local/README.md` ("Local HTTPS certificates") |

## Deepwell readiness

| Topic | Where it is documented |
|-------|-------------------------|
| JSON-RPC **ping** example (`curl` + `Authorization: Bearer …` to `http://localhost:2747/jsonrpc`) | `deepwell/README.md` |
| Container health check runs the same `ping` pattern | `install/common/deepwell/health-check.sh` (and `install/local/deepwell/health-check.sh`) |
| Framerail waits for Deepwell with the same **`ping`** RPC | `framerail/startup-readiness.ts` (`probeStartupDeepwell`) |

**Easy mistake:** Treating **port 2747 answering** as “wiki ready.” Deepwell can pass **`ping`** while **Framerail is still building** or while **Caddy** is still on a minimal config (see below). Prefer **`ping` +** a **host-routed** HTTPS check when proving the **edge** path.

## Caddy vs Deepwell at startup

| Topic | Where it is documented |
|-------|-------------------------|
| On start, if Deepwell is not reachable, Caddy logs **“Cannot reach DEEPWELL, using provisional Caddyfile”** and runs a **limited** site (HTTPS on **:18443** is not set up by that fallback) | `install/local/caddy/start.sh` |
| Cron invokes **`wikijump-update-caddyfile`** every **five minutes** to pull a generated Caddyfile from Deepwell and load it | `install/local/caddy/crontab`, `install/local/caddy/update-caddyfile.sh` |
| Manual regeneration / load path used by that job | `install/local/caddy/generate-caddyfile.sh`, `install/local/caddy/update-caddyfile.sh` |

**Easy mistake:** Hitting **`https://…:18443`** immediately after `compose up` and seeing **TLS errors** or wrong behavior while logs show the provisional message. **Deepwell healthy** is necessary but **Caddy may still be catching up** until the **update** job runs (within minutes) or the **Caddy** container is **restarted** after Deepwell is up, so a generated config is installed. This is implied by `start.sh` + `crontab`, not an undocumented special case.

## Seeded sites and pages

| Topic | Where it is documented |
|-------|-------------------------|
| Which hosts exist locally (`scp-wiki`, `scp-jp`, `scpaiueouiuiuiui`, etc.) and editable vs mirror boundary | `docs/development.md` ("Corpus Sites and Domain Boundaries"), `docs/local-authoring-boundary.md` |

**Easy mistake:** Assuming a specific **slug** on a mirror hostname is always present or renders; failures may be **data/import** state, not proof the stack is down. Treat as precondition on the dataset, not as generic stack health.
