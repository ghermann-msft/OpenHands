# agent-canvas Helm chart

Helm chart for running the [OpenHands agent-canvas](https://github.com/OpenHands/OpenHands)
all-in-one image (frontend + agent-server + automation) on Kubernetes as a
`StatefulSet` with persistent storage, an `Ingress`, and optional in-cluster
RBAC.

> [!WARNING]
> This Helm chart is experimental and single-tenant. Optional Microsoft Entra
> authentication protects access to the shared instance, but does not add
> project-aware authorization, tenant isolation, scale, or zero-downtime
> deployment support.

## When to use this

This chart turns a Kubernetes cluster into a shared, always-on Agent Canvas
backend: one pod running the UI, agent-server, and automation stack, with a
PVC that survives pod restarts and image upgrades. It's a good fit when you
want:

- **A self-hosted, persistent backend** instead of the laptop-friendly Docker
  setup — so conversations, secrets, and the automation SQLite DB persist
  across restarts without you managing the volume by hand.
- **An internal "vibecoding" platform.** With [RBAC enabled](#rbac), give the
  agent a skill that teaches it to deploy the small web apps it builds
  straight into the cluster. From that point on, anyone with access to the
  Agent Canvas UI can build and ship code into the cluster — and save it to
  GitHub — with just a prompt. No pipelines, no manual `kubectl`, no
  hand-written manifests.

Put it behind an authenticated ingress before exposing it to the internet (see
the [Security](#security) notes).

## Relationship to OpenHands Enterprise

Agent Canvas is a **single-tenant** application. This chart runs one shared
instance where all authenticated users share the same agents, pod, and PVC.
The optional native Microsoft Entra BFF authenticates users, but this milestone
does not add project-aware RBAC, per-user authorization, or tenant isolation.

[OpenHands Enterprise (OHE)](https://www.all-hands.ai/enterprise) is the
productized upgrade path when you need a hardened, multi-user deployment. OHE
adds:

- **Authentication** (SSO / SAML / OIDC) so users must log in.
- **Role-based access control** over who can run agents and manage the
  deployment.
- **Multi-tenancy** so different teams get isolated spaces.
- **Isolated agent sandboxes** — each agent run gets its own container rather
  than every agent sharing the pod's filesystem.

Use this chart for self-hosted, single-tenant setups; reach for OHE when you
need authentication, multi-tenancy, or isolated agent execution.

## TL;DR

```bash
helm install agent-canvas ./helm/agent-canvas
```

## What gets deployed

| Resource                           | Purpose                                                                                                                                                                                        |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `StatefulSet`                      | Single-replica pod running the all-in-one image (frontend + agent-server + automation).                                                                                                        |
| `PersistentVolumeClaim` (per pod)  | Backs `~/.openhands` and `~/workspace` (both mounted from the same PVC via `subPath`): settings, encrypted secrets, conversation history, automation SQLite DB, cloned repos, generated files. |
| `Service` (`ClusterIP` by default) | Cluster-internal endpoint on port 8000.                                                                                                                                                        |
| `Service` (headless)               | Required by the `StatefulSet` for stable pod DNS.                                                                                                                                              |
| `ServiceAccount`                   | Stable identity the pod runs under. Bindings depend on `rbac.*`.                                                                                                                               |
| `Ingress` (optional)               | External HTTP(S) entry point with the usual class/annotations/TLS knobs.                                                                                                                       |
| `RoleBinding` (per namespace)      | When `rbac.enabled=true`, one per entry in `rbac.namespaces`, bound to the built-in `admin` ClusterRole.                                                                                       |
| `ClusterRoleBinding` (optional)    | When `rbac.clusterAdmin=true`, binds the SA to `cluster-admin` cluster-wide.                                                                                                                   |

## Persistence

The chart provisions **one** PVC and mounts it at multiple well-known
subdirectories of the openhands user's HOME (`/home/openhands`) via
`subPath`. That preserves the pristine home directory the base image
ships (dotfiles like `~/.bashrc` and `~/.profile`) while persisting the
directories that actually contain state:

- `~/.openhands` — agent-server settings, encrypted secrets,
  conversation history and event stores, automation SQLite database
  (unless `config.automationDbUrl` is set), auto-generated
  `OH_SECRET_KEY`, session API key
- `~/workspace` — the agent's default working directory: cloned repos,
  worktrees, anything the agent writes when it treats `~` as the
  workspace root

Both paths share the same underlying disk. Add more entries to
`persistence.mounts` if you want other subtrees persisted (e.g.
`~/.cache`, `~/.config`).

The pod runs as `openhands` (UID 10001) from the upstream image;
`podSecurityContext.fsGroup=10001` makes the kubelet chown the PVC
so that user can write to it.

Point at an existing PVC with `persistence.existingClaim=<name>` if you
manage the volume out of band; otherwise the chart uses the
`StatefulSet`'s `volumeClaimTemplates` (recommended — data survives pod
rescheduling and image upgrades).

## RBAC

RBAC is **off by default** — the pod runs under its own ServiceAccount
but has no in-cluster permissions.

Two independent switches:

```yaml
rbac:
  enabled: true
  # Full access to all resources in these namespaces (bound to the
  # built-in `admin` ClusterRole via one RoleBinding per namespace).
  namespaces:
    - default
    - agent-sandbox
  # Optionally grant cluster-admin. OFF by default. Very broad — enable
  # only when the agent truly needs to manage the whole cluster.
  clusterAdmin: false
```

- `rbac.namespaces` creates one `RoleBinding` per namespace, referencing
  the built-in `admin` ClusterRole. Those namespaces must already exist
  in the cluster.
- `rbac.clusterAdmin=true` creates an additional `ClusterRoleBinding` to
  `cluster-admin`. This overrides / supersedes any per-namespace grant.

## Ingress

Standard knobs:

```yaml
ingress:
  enabled: true
  className: nginx
  annotations:
    nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
    nginx.ingress.kubernetes.io/proxy-body-size: "50m"
    cert-manager.io/cluster-issuer: letsencrypt-prod
  hosts:
    - host: agent-canvas.example.com
      paths:
        - path: /
          pathType: Prefix
  tls:
    - hosts:
        - agent-canvas.example.com
      secretName: agent-canvas-tls
```

The agent-server uses WebSockets on `/sockets`, so long
`proxy-read-timeout` / `proxy-send-timeout` values are recommended when
using `ingress-nginx`. File uploads honor `proxy-body-size`.

## Microsoft Entra authentication

The optional BFF mode uses the server-side authorization-code flow with PKCE.
The browser receives only secure HttpOnly cookies; Entra tokens and the
internal Agent Server session key are never written to browser JavaScript or
localStorage. `/alive`, `/health`, and `/ready` remain unauthenticated for
Kubernetes probes.

Use the existing single-tenant app registration for each candidate/primary
hostname by registering the exact callback URI
`https://<host>/auth/callback`. Store credentials in Kubernetes Secrets:

```bash
kubectl -n openhands create secret generic agent-canvas-entra \
  --from-literal=clientSecret='<entra-client-secret>' \
  --from-literal=cookieSecret='<at-least-32-random-bytes>'

kubectl -n openhands create secret generic agent-canvas-internal \
  --from-literal=sessionApiKey='<strong-random-internal-key>'
```

Then configure the release without putting secret material in values:

```yaml
entra:
  enabled: true
  tenantId: 00000000-0000-0000-0000-000000000000
  clientId: 11111111-1111-1111-1111-111111111111
  redirectUri: https://candidate.example.com/auth/callback
  clientSecret:
    existingSecret: agent-canvas-entra
    key: clientSecret
  cookieSecret:
    existingSecret: agent-canvas-entra
    key: cookieSecret

secrets:
  sessionApiKey:
    existingSecret: agent-canvas-internal
    key: sessionApiKey
```

Use the primary hostname in `entra.redirectUri` for the primary release.
Configuration is fail-fast: enabling Entra without tenant, client, redirect,
client-secret Secret reference, cookie-secret Secret reference, or internal
session-key Secret reference prevents the chart from rendering or the container
from starting.

## Common overrides

Provide an LLM key via secret:

```yaml
config:
  extraEnv:
    - name: LLM_MODEL
      value: openhands/claude-sonnet-4-5-20250929
    - name: LLM_API_KEY
      valueFrom:
        secretKeyRef:
          name: my-llm-secret
          key: api-key
```

Bring your own `OH_SECRET_KEY` (must match the value used to encrypt any
existing PVC contents):

```yaml
secrets:
  ohSecretKey:
    existingSecret: agent-canvas-keys
    key: ohSecretKey
```

Point automation at an external Postgres:

```yaml
config:
  automationDbUrl: postgresql+asyncpg://user:pass@postgres/agentcanvas
```

## Security

The agent server can read and write the pod filesystem, execute shell
commands, and — when RBAC is enabled — mutate the Kubernetes cluster it runs
in. Treat the release namespace as trusted infrastructure:

- Enable the native Entra BFF or put it behind an authenticated ingress before
  exposing it to the internet.
- Avoid a bare `LoadBalancer` — the agent server accepts any request with the
  right `LOCAL_BACKEND_API_KEY`, so exposing it directly means anyone who can
  guess the key can drive the agent.
- Only turn on `rbac.clusterAdmin` when you truly need cluster-wide access;
  prefer scoping to specific namespaces via `rbac.namespaces`.

For role-based access control, multi-tenancy, and isolated agent sandboxes, see
[OpenHands Enterprise](#relationship-to-openhands-enterprise).

## Uninstall

```bash
helm uninstall agent-canvas
```

By default the PVC created by `volumeClaimTemplates` is **retained**
after uninstall — delete it manually if you want the data gone. Set
`statefulSet.persistentVolumeClaimRetentionPolicy` (Kubernetes 1.27+) if
you want the PVC lifecycle tied to the StatefulSet.
