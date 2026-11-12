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
`halobuild` AKS user node pool, which is tainted against application workloads
and scales from zero to one node. Only the BuildKit container is privileged;
the Job and node are ephemeral, and no build service remains running between
builds. The Job clones the exact pushed commit, imports and exports its cache
through ACR, pushes a commit-tagged image, and reports the immutable digest
through its Kubernetes termination message.

`bootstrap` creates the `Standard_D8s_v5` build pool when it is absent and
rejects an existing pool whose VM size, autoscaling limits, label, or taint
does not match the configured isolation boundary. Routine `build`,
`deploy-candidate`, and `promote` commands use only Kubernetes access and do
not repeat the Azure, Entra, Key Vault, or Front Door bootstrap.

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
configured client CIDRs.

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

`bootstrap` also enforces the Entra contract for each environment: a v2
`access_as_user` scope preauthorized to the same confidential client. This
avoids an interactive permission-consent prompt without granting Microsoft
Graph access. Security-group claims remain disabled until application RBAC
needs them.

Both Front Door endpoints are protected by a shared WAF policy that blocks
clients outside the configured CIDR allowlist. The Application Gateway subnet
accepts the HTTP origin connection only from the `AzureFrontDoor.Backend`
service tag; direct Internet traffic to that origin port remains denied.
