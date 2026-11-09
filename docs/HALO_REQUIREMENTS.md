# OpenHands Halo requirements

This document records the initial requirements for OpenHands Halo, a modified
OpenHands deployment intended for shared development on Azure Kubernetes
Service (AKS).

## Goals

- Provide a shared, authenticated OpenHands service for multiple users and
  teams.
- Isolate conversations, workspaces, credentials, automations, and other
  resources by user, team, and project.
- Support project-aware authorization configured and enforced by OpenHands.
- Preserve a safe promotion path from candidate builds to the primary
  deployment.
- Use Microsoft Entra ID for enterprise identity without making Entra the
  source of project-level authorization policy.

## Delivery phases

### Phase 1: authentication and configuration

- Implement native Microsoft Entra authentication in OpenHands.
- Configure candidate and primary AKS services after authentication is working.
- During this phase, authenticated users share the current OpenHands
  authorization model and data boundary.
- Restrict Entra application assignment to a small trusted group until
  project-aware authorization is complete.

### Phase 2: project-aware authorization

- Add the organization, team, project, role, permission, and resource-isolation
  model described below.
- Do not represent phase 1 authentication as multi-tenant authorization.

### Explicit non-goals

- Do not reuse UnrealHands source code, middleware, deployment manifests, or
  architectural patterns.
- Do not introduce Temporal.
- Do not introduce a replacement or parallel control plane.
- Do not introduce a secondary project, workspace, conversation, automation, or
  execution lifecycle alongside the lifecycle already owned by OpenHands.
- Do not add a separate orchestration system to deliver authentication or the
  initial AKS deployment.

## Deployment

### Existing Azure environment

- Deploy OpenHands Halo in the existing `rg-unrealhands-dev` Azure resource
  group.
- Reuse only these existing platform resources:
  - AKS cluster `aks-unrealhands-dev`.
  - Virtual network `uh-unrealhands-dev-acukmd-vnet`.
  - Azure Container Registry `uhunrealhaacukmdbkacr`.
  - Key Vault `uh-unrealhand-acukmdbk`.
  - Existing purpose-specific managed identities where their current purpose
    and privileges match the OpenHands Halo workload.
- Treat existing `unrealhands-*` application workloads and resources as
  reference deployments, not dependencies of OpenHands Halo.
- Create dedicated OpenHands Halo resources and configuration for:
  - Kubernetes namespaces and workload placement.
  - Container image repository paths within the shared registry.
  - Kubernetes service accounts and workload-identity federated credentials.
  - Halo-specific Key Vault secret names and access assignments.
  - PostgreSQL databases.
  - Persistent storage.
  - Ingress listeners, routes, certificates, and hostnames.
- OpenHands Halo resources must use distinct names and selectors so existing
  UnrealHands workloads can continue operating without collision.
- Reused managed identities must retain a single documented purpose. Add
  namespace-specific federated credentials rather than introducing static
  client secrets.
- Candidate and primary access must remain least-privilege. Reuse an identity
  across both environments only when both environments are intentionally
  allowed to access the same Azure resources.

### AKS environments

- Run one AKS cluster with separate `candidate` and `primary` namespaces.
- `candidate` and `primary` must use separate:
  - Hostnames and ingress configuration.
  - Microsoft Entra applications or environment-specific redirect URIs and
    credentials.
  - Kubernetes service accounts and Azure workload identities.
  - Key Vault secrets.
  - PostgreSQL databases or schemas.
  - Persistent volumes.
- Keep `primary` on the last known-good version while changes are exercised in
  `candidate`.
- A separate recovery cluster is not required. Cluster-wide failure is an
  accepted shared failure domain.
- Use separate node pools for `candidate` and `primary` when practical.
- Apply resource quotas, resource limits, network policies, and pod
  anti-affinity to prevent candidate workloads from disrupting primary.

### Build and promotion

- Build OpenHands Halo images in CI and publish them to Azure Container
  Registry.
- Tag images with the source commit and deploy them by immutable image digest.
- Never deploy `latest`.
- Use GitOps, such as Flux or Argo CD, as the deployment authority.
- OpenHands may create changes or pull requests for deployment configuration,
  but must not directly deploy, restart, or replace itself.
- Promote the exact image digest validated in `candidate` to `primary`; do not
  rebuild between environments.
- Retain the previous image digest, Helm values, GitOps revision, and matching
  data snapshots for rollback.

### State and recovery

- Use Azure Database for PostgreSQL instead of the bundled automation SQLite
  database for persistent shared deployments.
- Snapshot primary PostgreSQL state and persistent volumes before promotion.
- Treat the application image, configuration, secret versions, database state,
  and persistent-volume state as one release unit for rollback.
- Keep source code authoritative in its Git provider. Persistent OpenHands
  workspaces must not be the only copy of development work.

## Authentication

- Reuse the existing single-tenant Entra app registration named
  `UnrealHands development console` with application ID
  `0fa13721-c53d-4d1b-9f27-a19c8a08a77d`.
- Reusing the Entra registration does not authorize reuse of UnrealHands code,
  authentication middleware, authorization behavior, deployment manifests, or
  architecture. OpenHands Halo authentication and authorization must be
  designed and implemented from the OpenHands contracts and these requirements.
- Add Halo-specific redirect URIs, app roles, and token configuration to the
  existing registration without retaining obsolete UnrealHands redirect URIs
  after their callers are retired.
- OpenHands must implement native Microsoft Entra authentication.
- Use a single-tenant Entra application and the authorization-code flow with
  PKCE.
- Browser authentication must use secure, HTTP-only, same-site session cookies.
  Authentication or access tokens must not be stored in browser local storage.
- Identify users by immutable Entra tenant and object IDs, not by email address
  or user principal name.
- Entra Conditional Access, MFA, account lifecycle, and security-group
  membership remain authoritative identity controls.
- An ingress authentication proxy may be retained as defense in depth, but it
  must not be the OpenHands authorization authority.
- All OpenHands HTTP, WebSocket, automation, callback, terminal, editor, and
  background execution paths must authenticate a principal.

## Authorization and tenancy

### Authority boundaries

| Authority | Responsibility |
| --- | --- |
| Microsoft Entra | Authentication, Conditional Access, account lifecycle, and group membership |
| OpenHands | Organizations, teams, projects, roles, permissions, ownership, sharing, and authorization decisions |
| Git provider | Repository, branch, pull request, and source-control authorization |
| AKS RBAC | Infrastructure and Kubernetes workload authorization |

- Entra roles and groups must not encode project lists or project-specific
  permission policy.
- OpenHands authorization must not grant repository access that the Git
  provider denies.
- Kubernetes RBAC must not be used as application-user RBAC.

### Resource isolation

- Users and teams may access only resources authorized for them.
- Authorization must cover at least:
  - Conversations and conversation events.
  - Workspaces, terminals, editors, and generated artifacts.
  - Credentials, secrets, model configuration, and MCP configuration.
  - Automations, schedules, runs, callbacks, and run history.
  - Repository connections and Git provider credentials.
  - Agent profiles, integrations, and saved settings.
- Every protected resource must have an explicit user, team, or project scope.
- User-private settings and credentials must remain inaccessible to team
  administrators unless a requirement explicitly grants access.
- Unauthorized resource identifiers should normally return `404` to avoid
  leaking the existence of resources.

### Principals and role bindings

- OpenHands must support these principal types:
  - Entra users.
  - Entra groups, identified by immutable group object ID.
  - OpenHands service accounts.
- Entra groups may be mapped to OpenHands teams or bound directly to roles at
  an OpenHands scope.
- Group synchronization must handle Entra group-claim overage rather than
  assuming every group is present in an identity token.
- Role bindings must associate a principal, role, and scope.
- Supported scopes must include organization and project, with narrower
  repository, workspace, or resource scopes where required.
- Permissions may inherit from organization to project, but sensitive
  permissions must support explicit grants.

### Initial roles and permissions

Initial fixed roles should include:

- Viewer.
- Contributor.
- Maintainer.
- Project Admin.
- Organization Admin.

Roles must be implemented as permission bundles so administrator-defined roles
can be added later without replacing authorization checks.

The permission model must support at least:

- `project.view` and `project.manage`.
- `conversation.create`, `conversation.view_all`, and `conversation.manage`.
- `workspace.read` and `workspace.execute`.
- `automation.view`, `automation.run`, and `automation.manage`.
- `secret.use` and `secret.manage`.
- `integration.use` and `integration.manage`.
- `member.invite` and `role.assign`.
- `audit.view`.

Sensitive capabilities such as `secret.manage`, `role.assign`, integration
management, and infrastructure execution must require explicit authorization.

### Enforcement

- Authorization must be enforced server-side and deny access by default.
- Database queries must include the authorized user, team, and project scope
  instead of loading arbitrary records and checking access afterward.
- WebSocket handshakes and subscriptions must be authorized independently of
  the initial page request.
- Background and scheduled work must carry a durable initiating principal,
  team or project scope, and service identity as applicable.
- Asynchronous execution must not become privileged merely because it runs
  outside the initiating request.
- Authorization decisions and administrative changes must be auditable.

## Kubernetes security

- OpenHands must not receive `cluster-admin`.
- OpenHands should not automatically receive a Kubernetes service-account
  token unless it requires Kubernetes API access.
- OpenHands must not be authorized to mutate its own namespace, deployment,
  ingress, secrets, GitOps controller, or primary environment.
- Agent-generated Kubernetes workloads must be deployed through GitOps or a
  narrowly scoped identity limited to disposable sandbox namespaces.
- Candidate identities must not access primary secrets, storage, databases, or
  service accounts.
- Use Azure Workload Identity and Key Vault integration instead of persistent
  Azure client secrets wherever supported.

## Execution isolation

- Multi-user execution must not rely on all conversations sharing one pod and
  filesystem.
- Each conversation or equivalent execution unit must run in an isolated
  sandbox with its own workspace and explicitly injected credentials.
- Sandbox credentials must be limited to the initiating user, team, project,
  and operation.
- Conversation cleanup must remove or archive its execution environment without
  deleting durable records required for history or audit.

## Repository boundaries

This feature spans multiple OpenHands repositories:

1. `OpenHands/software-agent-sdk` owns Agent Server authentication,
   authorization enforcement, conversations, workspaces, events, execution,
   canonical REST and WebSocket contracts, and the TypeScript client.
2. `OpenHands/automation` owns automation definitions, scheduling, webhooks,
   run history, callbacks, and dispatch.
3. `OpenHands/OpenHands` owns Agent Canvas UI, authenticated frontend state,
   administration experiences, and consumption of the backend contracts.
4. `OpenHands/extensions` owns reusable skills, plugins, and integrations where
   authorization-aware extension behavior is required.

Backend contracts and enforcement must be implemented before frontend controls.
Frontend visibility or disabled controls must never be treated as an
authorization boundary.

## Enterprise compatibility reference

OpenHands Enterprise provides a useful baseline:

- Keycloak-backed authentication and role-based access control.
- Personal workspaces and team organizations.
- Organization roles of Member, Admin, and Owner.
- An instance-level Super Admin role that does not automatically grant access
  to organization data.
- Private user settings and private conversations by default.
- Git-provider permissions as the authority for repository access.

OpenHands Halo additionally requires first-class project scopes, Entra groups
as principals, project-aware role bindings, and permission bundles suitable for
future administrator-defined roles.
