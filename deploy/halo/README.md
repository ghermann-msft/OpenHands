# OpenHands Halo deployment

Halo uses one repository-owned command for repeatable AKS builds and
candidate-to-primary promotion:

```powershell
npm run halo -- bootstrap
npm run halo -- bootstrap-ci --github-app-id <id> --github-app-installation-id <id> --github-app-private-key <path-to-pem>
npm run halo -- build --ref HEAD
npm run halo -- deploy-candidate --digest sha256:<digest>
npm run halo -- promote
npm run halo -- status
```

`build` creates an ephemeral BuildKit Job in the dedicated
`openhands-halo-build` namespace. The Job runs only on the dedicated
`halobuildssd` AKS user node pool, which is tainted against application
workloads and keeps one `Standard_D16ds_v5` node warm. The pool places kubelet
ephemeral storage on a 256 GiB Ephemeral OS disk backed by its temporary SSD.
Only the BuildKit container is privileged; the Job is ephemeral, and no build
service remains running between builds. BuildKit also imports and exports cache
through ACR. The Job clones the exact pushed commit, builds independent images
concurrently, pushes commit-pinned images, and reports their immutable digests
through its Kubernetes termination message.

`bootstrap` creates the `Standard_D16ds_v5` build pool when it is absent and
rejects an existing pool whose VM size, disk configuration, autoscaling limits,
label, or taint does not match the configured isolation boundary. Routine `build`,
`deploy-candidate`, and `promote` commands use only Kubernetes access and do
not repeat the Azure, Entra, Key Vault, or Front Door bootstrap.

Windows Agent Server images use public GHCR only as the build handoff.
`preflight-windows` runs a server-side ACR import of the exact GHCR digest
through a dedicated federated workload identity with the
`Container Registry Data Importer and Data Reader` role, verifies that ACR
retained the same digest, and then pre-pulls that immutable ACR reference on
the Windows pool. Runtime templates never pull the Windows image from GHCR and
do not use registry credentials or image pull secrets.

`deploy-candidate` installs that digest into the isolated PPE namespace,
mounting Key Vault secrets through the Azure Secrets Store CSI driver, and
waits for the StatefulSet and PPE endpoint to become ready.

`promote` reads the image digest actually running in PPE and deploys that exact
reference to primary. It refuses mutable tags and does not rebuild. Candidate
and primary use separate namespaces, PVCs, Entra credentials, cookie keys,
internal API keys, settings encryption keys, and Automation KV keys.

## GitHub Actions deployment loop

The `Halo deployment` workflow validates every push to `openhands-halo` on a
GitHub-hosted runner, then uses an ephemeral in-cluster runner to build the
image and deploy its digest to PPE. The same run then waits at the protected
`halo-production` environment. Approving that job promotes the exact digest
built by the run, without rebuilding it; promotion fails if PPE has moved to a
newer digest while approval was pending. Pull requests never run on the
self-hosted scale set. Deployment readiness and authentication smoke checks
use the in-cluster service because Front Door intentionally permits only the
configured client CIDRs. Sandbox runtime URLs use the canonical Front Door
origin for both browsers and Sandbox Server; the AKS NAT gateway's fixed egress
address has a separate explicit service allow rule.

Halo locks Canvas to its Sandbox Server backend but does not deploy the
commercial hosted settings shell. The container therefore runs with
`AGENT_CANVAS_EXTERNAL_SETTINGS_SHELL=false`: Canvas keeps its open-source
settings pages, while deployment-owned LLM configuration remains hidden through
the Sandbox Server feature flag.

`bootstrap-ci` installs Actions Runner Controller and the runner scale set from
the pinned `0.15.1` Helm charts. The controller and listener run on the warm
services pool. Ephemeral runners run on the tainted, scale-to-zero build pool
and use a namespace-scoped ServiceAccount. The runner can manage build Jobs
and the two Halo namespaces but has no cluster-wide role.

Create a dedicated GitHub App owned by `ghermann-msft`, install it only on the
`OpenHands` repository, and configure:

- Repository `Administration`: read and write.
- Repository `Metadata`: read-only.
- Homepage URL: `https://github.com/actions/actions-runner-controller`.

Pass its App ID, installation ID, and generated private-key file to
`bootstrap-ci`. The command saves the credential JSON in Azure Key Vault,
synchronizes the required Kubernetes Secret, and installs or upgrades ARC.
Subsequent `bootstrap-ci` runs can omit those arguments and restore the
Kubernetes Secret from Key Vault.

Create GitHub environments named `halo-ppe` and `halo-production`. Configure
`halo-production` with the required human reviewer; `halo-ppe` intentionally
has no approval gate. The cluster needs outbound HTTPS access to GitHub and
GHCR, but no inbound connection from GitHub and no public Kubernetes API.

Halo uses separate federated workload identities for PPE and production. Each
identity has `Key Vault Secrets User` on the Halo vault and `Cognitive Services
OpenAI User` on `mortmain-openai2`; no Azure OpenAI API key is stored. The
default LLM profile uses the `gpt-5.6-sol` deployment through the Azure endpoint,
and the SDK refreshes Entra access tokens through `DefaultAzureCredential`.

Conversation state is stored on a separate retained Azure Files PVC in each
environment and mounted at `/home/openhands/conversations`. The shared Canvas
control plane keeps its remaining state on the environment's Azure Disk. The
first rollout copies any existing conversation directories from that disk when
the Azure Files share is empty.

Halo workspaces are source-control neutral. The authenticated Entra BFF exposes
`/api/workspace-runtimes` to create an empty workspace or initialize one from
an HTTPS Git repository. Each workspace gets a retained Azure Managed Disk
PVC, one Agent Server Deployment with `Recreate` rollout semantics, and one
ClusterIP Service. The runtime mounts its disk at `/workspace` and stores its
conversation state under a workspace-specific directory on the shared Azure
Files volume. Stopping or replacing the runtime leaves both stores intact.
Git initialization uses an on-disk progress marker and copies `.git` last, so
an interrupted copy can be retried without adopting a partial checkout.
Deleting a workspace requires the explicit `deleteStorage=true` confirmation.

The control-plane ServiceAccount has only namespace-scoped permissions for
workspace ConfigMaps, PVCs, Services, and Deployments. Runtime pods use the
same identity for Key Vault access but disable ServiceAccount token mounting,
so agent workloads cannot call the Kubernetes API.

All names and non-secret Azure identifiers live in `deploy/halo/config.json`.
Secret values stay in Azure Key Vault.

## Candidate Hindsight memory service

Halo PPE deploys Hindsight as a candidate-only Linux service. The API image is
the immutable `ghcr.io/vectorize-io/hindsight-api:1.2.1` manifest digest
recorded in `deploy/halo/config.json`; that release was published on
2026-11-10. The source and licensing review is pinned to
`vectorize-io/hindsight@b5f5968ebf2a7dbe6363809fac0b31e428008171`.
Its `LICENSE` is MIT and its README identifies the project as MIT. Halo does
not copy Hindsight source.

The service has no ingress and only a ClusterIP. A NetworkPolicy permits API
traffic only from the trusted Sandbox Server pod, while the existing sandbox
template can reach Sandbox Server but not Hindsight. Hindsight requires a
bearer key on every data request; only Sandbox Server and the Hindsight pod
receive that Key Vault-backed secret. The URL and key are never rendered into
sandbox templates or sandbox environment variables.

PPE uses a separate `openhands_hindsight_ppe` database, role, and `hindsight`
schema on the existing private PostgreSQL 16 Flexible Server. `bootstrap`
validates PostgreSQL 15+, allowlists the `VECTOR` extension, creates the
database/role/schema, and installs pgvector. Password authentication remains
enabled only because Hindsight does not natively refresh Azure Database for
PostgreSQL workload-identity tokens; the password stays in Key Vault and the
server remains private. The bootstrap and runtime pods read secrets through
Azure Workload Identity and the Secrets Store CSI driver.

Create these PPE Key Vault secrets before `bootstrap`:

- `halo-ppe-hindsight-database-password`
- `halo-ppe-hindsight-api-key`
- `halo-ppe-hindsight-llm-api-key`
- `halo-ppe-hindsight-bank-secret`
- `halo-ppe-hindsight-scope-bindings-json`

The LLM key is the Azure OpenAI resource key for `mortmain-openai2`; it is
mounted only into Hindsight. Hindsight uses the full API image so embeddings
and reranking remain local to the service.

Sandbox Server is the authorization broker and owns durable bank identity,
retain/recall calls, and fail-open behavior. Its deployment contract enables
Hindsight only in PPE and only for Linux OpenHands conversations, with
automatic recall ceilings of 1,024 tokens by default and 2,048 adaptively, and
an explicit deep recall/reflect ceiling of 4,096. A Hindsight outage must not
block normal conversation startup or messages. Any agent-facing deep-recall
request shape belongs in `OpenHands/software-agent-sdk`; Sandbox Server must
consume that canonical contract rather than creating a second wire format.
The deployment-owned `OH_HINDSIGHT_DEPLOYMENT_ID=halo-ppe` derives the typed
server-wide bank and is configured only on Sandbox Server. Every authenticated
bound session may recall and retain server-wide memory. Callers cannot supply
or override the deployment or bank identifier.
The broker reads the Hindsight bearer key and bank secret exclusively from
`OH_HINDSIGHT_API_KEY_FILE` and `OH_HINDSIGHT_BANK_SECRET_FILE`. Organization
definitions and repository/workspace associations come from
`OH_HINDSIGHT_SCOPE_BINDINGS_JSON_FILE`. These files use a dedicated
broker-only CSI mount; their values are never environment variables or sandbox
configuration. The scope-bindings file is
`{"organizations":{"personal-user-id":{"display_name":"Personal","kind":"personal"},"halo-studios":{"display_name":"Halo Studios","kind":"shared"}},"repositories":{"github:owner/repo":{"organization_ids":["personal-user-id","halo-studios"]}}}`.
Stable organization IDs and repository allowlists are trusted deployment data;
display names and kinds are metadata. Membership, roles, permissions, and
allowed users are not deployment data: OpenHands RBAC owns them. Sandbox
Server derives repository and workspace identity from trusted conversation
metadata, verifies the selected organization against the repository allowlist
and signed OpenHands RBAC context, and never accepts caller-provided scope IDs.

Candidate Linux OpenHands profiles set `OH_DEFERRED_INIT=true`. Sandbox Server
keeps `OH_HINDSIGHT_BROKER_URL=http://openhands-sandbox-server:3000` in its
trusted control-plane environment and passes the broker URL, identity, and
authorized scope only through the authenticated `/api/init` payload. The
dynamically injected `OH_SESSION_API_KEYS_0` remains the Agent Server bootstrap
credential used for `X-Init-API-Key`. Windows and ACP profiles are outside this
PoC and do not enable deferred init. Hindsight service credentials, bank
secrets, and scope configuration never enter the payload or sandbox specs.

Entra authenticates immutable tenant/object identity only; Halo does not use
Entra group claims as its application authorization database. The durable
OpenHands UserAuth/RBAC contract must authorize that identity and bind trusted
`tenant_id`, `object_id`, `organization_id`, `role`, and `permissions` fields
to `AppConversationInfo`/conversation metadata. The broker fails closed unless
that context is present, requires `hindsight:recall` or `hindsight:retain` for
the corresponding organization/repository/workspace operation, and requires
its ordered `{type:"organization",id:"<stable-id>"}` scope to match the signed
RBAC context. Server scope follows the explicit all-authenticated-session
recall/retain policy but still requires immutable authenticated identity.
Canvas already models an active organization for Cloud backends in the
lower-left backend selector, but Halo still needs a control-plane
organization-list contract that exposes Personal and Halo Studios and binds
the selected stable ID when creating a conversation. No deployment membership
file remains; any initial membership seeding belongs to an OpenHands RBAC seed
or migration, not the Hindsight broker.

`bootstrap` also enforces the Entra contract for each environment: a v2
`access_as_user` scope preauthorized to the same confidential client. This
avoids an interactive permission-consent prompt without granting Microsoft
Graph access. Security-group claims remain disabled until application RBAC
needs them.

Both Front Door endpoints are protected by a shared WAF policy that blocks
clients outside the configured CIDR allowlist. The Application Gateway subnet
accepts the HTTP origin connection only from the `AzureFrontDoor.Backend`
service tag; direct Internet traffic to that origin port remains denied.
