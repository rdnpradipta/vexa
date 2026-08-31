# Compose deployment overlays

_Governed by `docs/docs/governance/architecture.mdx`._

## Development overlay

`docker-compose.ext.yml` bind-mounts the extension into meeting-api for a local development loop:

```bash
docker compose -p vexa \
  -f deploy/compose/docker-compose.yml \
  -f ext/compose/docker-compose.ext.yml \
  up -d --no-build --no-deps meeting-api
```

- `VEXA_EXT_STRATEGY=postwrap` keeps the upstream composition root and adds routes.
- `VEXA_EXT_STRATEGY=root` swaps the meeting repository and therefore requires a valid
  `VEXA_EXT_TENANT_ID`.
- `VEXA_EXT_TENANT_ID` is a 1-64 character lowercase deployment identifier using letters, digits,
  and internal hyphens. There is no `unassigned` production fallback.

The bind mount is development-only.

## Hardened single-tenant production overlay

`docker-compose.production.yml` is merged after the upstream Compose file. It:

- bakes `ext/vexa_ext` into the meeting-api image with
  `Dockerfile.meeting-api-production`;
- keeps gateway and every application/data service un-published;
- exposes a credential-free loopback API relay at `127.0.0.1:18056` and an authenticated relay on
  this host's private Tailscale address `100.71.128.112:18058` for the cross-runtime Podman bridge;
- keeps Terminal opt-in behind the explicit `internal-ui` profile; when enabled, a separate relay at
  `100.71.128.112:18059` reaches only Terminal over a dedicated internal `ui_ingress` network;
- requires Terminal local login to use an exact email allowlist plus a salted, memory-hard scrypt
  verifier for a high-entropy password, with atomic per-client and global failure reservations;
- removes all direct host mappings for databases and internal APIs;
- requires independent database, object-store, administrator, internal-service, gateway-identity,
  dispatch-signing, and session secrets;
- removes the agent fallback subject and requires authenticated gateway service identity;
- uses a gateway-only internal `ingress` network with fixed relay identities, separate internal
  `control` and `data` networks, plus the runtime `workload` network;
- configures gateway to trust forwarded client identity only from the two exact ingress relay IPs;
- runs long-lived services read-only, capability-dropped, no-new-privileges, PID-limited,
  memory-limited, CPU-limited, and log-limited;
- mounts the rootless Docker socket only into runtime;
- disables transcription and recording until explicit providers, consent, and retention controls
  are configured.

This is an **instance-per-tenant boundary**. `ext_tenant` records provenance, while isolation comes
from the dedicated service set, databases, object store, Redis, networks, and volumes. It is not a
claim of row-level multi-tenant isolation or PostgreSQL RLS.

Validate without creating resources. The env file must include an explicit, stable
`COMPOSE_PROJECT_NAME`; runtime-spawned workload network and workspace-volume names derive from it:

```bash
docker compose \
  --env-file /path/to/production.env \
  -f deploy/compose/docker-compose.yml \
  -f ext/compose/docker-compose.production.yml \
  config -q
```

Build and start:

```bash
docker compose \
  --env-file /path/to/production.env \
  -f deploy/compose/docker-compose.yml \
  -f ext/compose/docker-compose.production.yml \
  --profile build-only build agent-worker

docker compose \
  --env-file /path/to/production.env \
  -f deploy/compose/docker-compose.yml \
  -f ext/compose/docker-compose.production.yml \
  up -d --build --wait
```

Never commit the production environment file or print its values. The deployed secret file must be
owner-only (`0600`) and stored outside the repository.
