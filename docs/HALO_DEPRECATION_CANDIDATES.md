# OpenHands Halo deprecation candidates

This document lists resources in `rg-unrealhands-dev` and
`aks-unrealhands-dev` that may be retired as OpenHands Halo replaces the
existing UnrealHands application stack.

This is a deprecation list, not deletion authorization. Before removing a
resource:

1. Identify its owner and authoritative infrastructure definition.
2. Confirm that no active workload, automation, DNS record, role assignment, or
   external client depends on it.
3. Export or snapshot data subject to retention requirements.
4. Disable or scale down the resource and observe the agreed retirement window.
5. Remove the resource through its infrastructure-as-code or GitOps owner.

## Retain and reuse

Do not deprecate these shared platform resources:

- Resource group `rg-unrealhands-dev`.
- AKS cluster `aks-unrealhands-dev`.
- Virtual network `uh-unrealhands-dev-acukmd-vnet` and AKS subnets.
- Azure Container Registry `uhunrealhaacukmdbkacr`.
- Key Vault `uh-unrealhand-acukmdbk`.
- Existing purpose-specific managed identities that are assigned a documented
  OpenHands Halo responsibility.
- ACR and Key Vault private endpoints and private DNS zones.
- AKS control-plane and kubelet managed identities.
- AKS system components, Calico, the Key Vault CSI provider, and required
  ingress-controller components.

## High-confidence deprecation candidates

### Disabled Azure Front Door configuration

The Front Door endpoint is disabled and currently has no routes.

- Front Door profile `uh-unrealhands-dev-fd`.
- Endpoint `uh-unrealhands-dev-fd/unrealhands-dev-acukmdbk`.
- Origin group `unrealhands-aks`.
- Origin `canvas-bff`.

Retirement gate: confirm no DNS CNAME, monitoring probe, deployment pipeline,
or planned Halo edge design still references the Front Door endpoint.

### Empty qualification namespaces

No pods, jobs, or cron jobs were present during the inventory.

- Kubernetes namespace `unrealhands-executor-qualification`.
- Kubernetes namespace `unrealhands-w1-qualification`.

Retirement gate: inspect non-workload objects such as secrets, config maps,
role bindings, and finalizers, and confirm the qualification pipelines no
longer target these namespaces.

### Unattached workspace disks

These managed disks were unattached during the inventory:

- `uh-ws-d238f72d`.
- `uh-ws-269da238`.
- `uh-ws-46e6be82`.

Retirement gate: identify the workspace or build that created each disk,
snapshot any retained data, and verify that no controller expects to reattach
it.

## Deprecate after OpenHands Halo cutover

### Existing OpenHands application namespace

Retire namespace `unrealhands-openhands` after candidate and primary Halo
instances replace it. The namespace currently contains:

- Deployment `agent-server`.
- Deployment `canvas`.
- Service `agent-server`.
- Service `canvas`.
- Ingress `canvas`.
- Service account `openhands-llm`.
- Network policies:
  - `agent-server-ingress`.
  - `canvas-egress`.
  - `canvas-ingress`.
  - `openhands-agent-server-client`.
- Persistent volume claims:
  - `openhands-identity-state`.
  - `openhands-state`.
  - `openhands-workspace`.

Retirement gates:

- Halo candidate and primary pass their acceptance gates.
- Existing conversations, identity state, settings, and workspace data have
  been migrated, archived, or explicitly abandoned.
- The old hostname no longer receives traffic.
- Rollback no longer depends on the old namespace.

Keep the managed identity
`uh-unrealhands-dev-openhands-llm-mi` if it is reused by Halo. Remove only the
old federated credential whose subject is
`system:serviceaccount:unrealhands-openhands:openhands-llm` after the old
service account is retired.

### Existing Application Gateway route

Retire the route-specific configuration for the old Canvas deployment after
Halo ingress is live:

- Hostname `unrealhands-dev-origin-acukmdbk.westus3.cloudapp.azure.com`.
- Backend pool `pool-unrealhands-openhands-canvas-8080-bp-8080`.
- Backend setting `bp-unrealhands-openhands-canvas-8080-8080-canvas`.
- Health probe `pb-unrealhands-openhands-canvas-8080-canvas`.
- HTTP and HTTPS listeners generated for the old hostname.
- Request-routing and HTTP-to-HTTPS redirect rules generated for the old
  hostname.
- Certificate `canvas-self-signed`, if it is not reused by any other listener.

Do not deprecate Application Gateway `uh-unrealhands-dev-appgw`, its public IP,
or its network security group until the Halo ingress architecture decides
whether those shared resources will be reused.

### Legacy ACR repositories and tags

Keep the ACR, but retire repositories and old tags that are used only by the
replaced UnrealHands stack:

- `unrealhands-agent-server`.
- `unrealhands-openhands`.
- `control-plane`.
- `control-agent`.
- `control-agent-windows`.
- `control-executor`.
- `control-executor-qualification`.
- `control-oidc-fixture`.
- `local-platform`.
- `build-contexts`.
- `perforce-broker`.
- `perforce-fixture`.
- `perforce-windows`.
- `vs2026-toolchain`.
- `windows-build-context`.

Retirement gates:

- No Kubernetes workload, qualification pipeline, rollback manifest, or build
  pipeline references the repository or digest.
- Required release and security-retention periods have elapsed.
- Halo images use dedicated repository paths.

Delete individual tags and manifests according to a retention policy rather
than deleting the shared registry.

## Conditional platform deprecation candidates

These resources belong to the existing UnrealHands control platform. They
should be retired only if OpenHands Halo replaces that platform's functions,
not merely its Canvas deployment.

### Namespace `unrealhands-local`

Current long-running components include:

- Deployment and service `control-plane`.
- Deployment and service `code-egress-proxy`.
- Deployment and service `postgres`.
- Deployment and service `temporal`.
- Service `control-agent-gateway`.
- Temporal schema and namespace initialization jobs.
- Dynamic control-agent and control-executor jobs, pods, services, and PVCs.
- Service account `local-platform`.
- Related network policies, config maps, secrets, role bindings, and other
  namespace-scoped resources.

The inventory found pending and failed execution pods and jobs, along with many
`uh-active-*` and `uh-runtime-*` PVCs. These are cleanup candidates, but they
may contain active or retained workspace data.

Retirement gates:

- Halo has replacements for control-plane orchestration, execution isolation,
  egress control, durable workflow behavior, and artifact handling.
- No active or recoverable execution refers to the namespace.
- PostgreSQL and Temporal data have been migrated or archived.
- Workspace PVC retention requirements have been applied.

### Deallocated Windows build VM

The VM was deallocated during the inventory:

- VM `uh-wb-d238f72d`.
- OS disk `uh-wb-d238f72d-os`.
- NIC `uh-wb-d238f72d-nic`.
- NSG `uh-wb-d238f72d-nsg`.
- VM extensions and run-command resources beneath `uh-wb-d238f72d`.

Retirement gate: confirm that no Windows image, toolchain, Perforce, native
inspection, or qualification workflow depends on this VM.

### Existing artifact storage

If Halo receives new persistent and artifact storage, consider retiring:

- Storage account `uhunrealhaacukmdbkst`.
- Private endpoint `uh-unrealhands-dev-acukmd-blob-pe`.
- The private-endpoint network interface created for that endpoint.

Keep the shared `privatelink.blob.core.windows.net` private DNS zone if Halo or
another workload continues using private Blob Storage.

Retirement gates:

- Inventory the storage containers from a network location allowed by the
  account firewall.
- Migrate or expire retained reports, artifacts, and workspace data.
- Remove the `Storage Blob Data Contributor` assignment from
  `uh-unrealhands-dev-acukmd-artifacts-runtime-mi` only if that identity no
  longer needs the old account.
- Confirm no workflow uses the old account endpoint.

## Managed identities

The current direction is to reuse managed identities, so none are general
deprecation candidates. Review and remove obsolete federated credentials and
role assignments after their old Kubernetes service accounts or Azure
resources are retired:

- `uh-unrealhands-dev-acukmd-credentials-broker-mi`.
- `uh-unrealhands-dev-acukmd-artifacts-runtime-mi`.
- `uh-unrealhands-dev-openhands-llm-mi`.

Do not remove:

- `uh-unrealhands-dev-acukmd-aks-controlplane-mi`.
- `uh-unrealhands-dev-acukmd-aks-kubelet-mi`.

Each retained identity must have one documented purpose and least-privilege
role assignments.
