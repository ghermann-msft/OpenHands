# OpenHands Halo deployment

Halo uses one repository-owned command for repeatable AKS builds and
candidate-to-primary promotion:

```powershell
npm run halo -- bootstrap
npm run halo -- build --ref HEAD
npm run halo -- deploy-candidate --digest sha256:<digest>
npm run halo -- promote
npm run halo -- status
```

`build` creates an ephemeral BuildKit Job in the dedicated
`openhands-halo-build` namespace. The pod uses Kubernetes native user
namespaces (`hostUsers: false`) and BuildKit's native snapshotter, so BuildKit
runs as root only inside an unprivileged pod user namespace without a
privileged container. The Job clones the exact pushed commit, imports and
exports its cache through ACR, pushes a commit-tagged image, and prints the
immutable digest.

`deploy-candidate` installs that digest into the isolated PPE namespace,
mounting Key Vault secrets through the Azure Secrets Store CSI driver. It
configures and enables only the PPE Azure Front Door endpoint after the
StatefulSet is ready.

`promote` reads the image digest actually running in PPE and deploys that exact
reference to primary. It refuses mutable tags and does not rebuild. Candidate
and primary use separate namespaces, PVCs, Entra credentials, cookie keys,
internal API keys, settings encryption keys, and Automation KV keys.

All names and non-secret Azure identifiers live in `deploy/halo/config.json`.
Secret values stay in Azure Key Vault.

`bootstrap` also enforces the Entra contract for each environment: a v2
`access_as_user` scope preauthorized to the same confidential client. This
avoids an interactive permission-consent prompt without granting Microsoft
Graph access. Security-group claims remain disabled until application RBAC
needs them.
