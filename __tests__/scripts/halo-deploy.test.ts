// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  appGatewayNsgRuleArgs,
  buildDigestsFromPodList,
  buildNodePoolCreateArgs,
  entraIdentifierUri,
  frontDoorOriginCreateArgs,
  frontDoorOriginGroupCreateArgs,
  imageReference,
  normalizeDigest,
  postgresServerCreateArgs,
  renderArcControllerValues,
  renderArcRunnerRbac,
  renderArcRunnerValues,
  renderAgentSandboxResources,
  renderBuildJob,
  renderConversationPvc,
  renderConversationStorageClass,
  renderFrontDoorSecurityPolicy,
  renderFrontDoorWafPolicy,
  renderHelmValues,
  renderPostgresBootstrapJob,
  renderSandboxServerResources,
  renderSecretProviderClass,
  renderWorkspaceStorageClass,
  runtimeNodePoolAutoscalerArgs,
  validateBuildNodePool,
} from "../../scripts/halo-deploy.mjs";

const digest = `sha256:${"a".repeat(64)}`;
const commit = "84d224f45e7647c3a04d4b8ac4af47af22a23b12";

describe("Halo deployment automation", () => {
  it("requires immutable image digests", () => {
    expect(normalizeDigest(digest)).toBe(digest);
    expect(() => normalizeDigest("84d224f45")).toThrow(/immutable sha256/);
    expect(imageReference("registry.example", "openhands-halo", digest)).toBe(
      `registry.example/openhands-halo@${digest}`,
    );
  });

  it("renders an isolated privileged cached build for the exact commit", () => {
    const job = renderBuildJob({ commit });

    expect(job).toContain(`git checkout --detach ${commit}`);
    expect(job).toContain(
      "git checkout --detach 6214d63812f5d70a27c4ba6577c11c3d1d482d6d",
    );
    expect(job).toContain(`OPENHANDS_BUILD_GIT_SHA=${commit}`);
    expect(job).toContain("containers/app/Dockerfile");
    expect(job).toContain("--opt target=openhands-sandbox-server");
    expect(job).toContain(
      "name=uhunrealhaacukmdbkacr.azurecr.io/openhands-sandbox-server:",
    );
    expect(job).toContain(
      "AGENT_SERVER_SDK_GIT_REPOSITORY=https://github.com/ghermann-msft/software-agent-sdk.git",
    );
    expect(job).toContain(
      "AGENT_SERVER_SDK_GIT_REF=23fba4b2b914d87f191a92aed2c41cb86545ab43",
    );
    expect(job).toContain("--import-cache type=registry");
    expect(job).toContain("--export-cache type=registry");
    expect(job).toContain('azure.workload.identity/use: "true"');
    expect(job).toContain("agentpool: halobuild");
    expect(job).toContain("value: halo-build");
    expect(job).toContain("privileged: true");
    expect(job).not.toContain("hostUsers: false");
    expect(job).not.toContain("--oci-worker-no-process-sandbox");
    expect(job).not.toContain('add: ["SYS_ADMIN"]');
    expect(job).not.toContain("type: Unconfined");
    expect(job).toContain("ttlSecondsAfterFinished: 600");
    expect(job).toContain("--metadata-file");
    expect(job).toContain("> /dev/termination-log");
  });

  it("reads both immutable digests reported by the completed build container", () => {
    expect(
      buildDigestsFromPodList({
        items: [
          {
            status: {
              containerStatuses: [
                {
                  name: "buildkit",
                  state: {
                    terminated: {
                      message: JSON.stringify({
                        canvas: digest,
                        sandboxServer: `sha256:${"b".repeat(64)}`,
                      }),
                    },
                  },
                },
              ],
            },
          },
        ],
      }),
    ).toEqual({
      canvas: digest,
      sandboxServer: `sha256:${"b".repeat(64)}`,
    });
    expect(() => buildDigestsFromPodList({ items: [] })).toThrow(
      /did not publish immutable image digests/,
    );
  });

  it("renders pinned ephemeral ARC runners on the isolated build pool", () => {
    const controller = renderArcControllerValues();
    const runner = renderArcRunnerValues();
    const rbac = renderArcRunnerRbac();

    expect(controller).toContain("fullnameOverride: openhands-halo-arc");
    expect(controller).toContain("agentpool: services");
    expect(runner).toContain(
      'githubConfigUrl: "https://github.com/ghermann-msft/OpenHands"',
    );
    expect(runner).toContain("githubConfigSecret: openhands-halo-github-app");
    expect(runner).toContain("runnerScaleSetName: openhands-halo-ci");
    expect(runner).toContain("minRunners: 0");
    expect(runner).toContain("maxRunners: 1");
    expect(runner).toContain("image: ghcr.io/actions/actions-runner:2.338.1");
    expect(runner).toContain("runAsUser: 1001");
    expect(runner).toContain("runAsGroup: 1001");
    expect(runner).toContain("agentpool: halobuild");
    expect(rbac).toContain("namespace: openhands-halo-build");
    expect(rbac).toContain("name: openhands-halo-ci-agent-sandbox");
    expect(rbac).toContain(
      'resources: ["sandboxtemplates", "sandboxwarmpools"]',
    );
    expect(rbac).toContain(
      'verbs: ["create", "delete", "get", "list", "patch", "update", "watch"]',
    );
    expect(rbac).toContain("namespace: openhands-halo-ppe");
    expect(rbac).toContain("namespace: openhands-halo-primary");
    expect(rbac).not.toContain("ClusterRoleBinding");
  });

  it("defines and validates the scale-to-zero build pool boundary", () => {
    const args = buildNodePoolCreateArgs();

    expect(args).toContain("halobuild");
    expect(args).toContain("Standard_D8s_v5");
    expect(args).toContain("--enable-cluster-autoscaler");
    expect(args).toContain("--ssh-access");
    expect(args).toContain("disabled");
    expect(args).toContain("unrealhands.io/pool=halo-build:NoSchedule");
    expect(() =>
      validateBuildNodePool({
        mode: "User",
        osType: "Linux",
        osSku: "Ubuntu",
        vmSize: "Standard_D8s_v5",
        enableAutoScaling: true,
        minCount: 0,
        maxCount: 1,
        securityProfile: {
          sshAccess: "Disabled",
        },
        nodeLabels: {
          "unrealhands.io/pool": "halo-build",
        },
        nodeTaints: ["unrealhands.io/pool=halo-build:NoSchedule"],
      }),
    ).not.toThrow();
    expect(() =>
      validateBuildNodePool({
        mode: "User",
        osType: "Linux",
        osSku: "Ubuntu",
        vmSize: "Standard_D8s_v5",
        enableAutoScaling: true,
        minCount: 0,
        maxCount: 1,
        securityProfile: {
          sshAccess: "LocalUser",
        },
        nodeLabels: {
          "unrealhands.io/pool": "halo-build",
        },
        nodeTaints: ["unrealhands.io/pool=halo-build:NoSchedule"],
      }),
    ).toThrow(/SSH access disabled/);
  });

  it("restricts Front Door clients and its Application Gateway origin", () => {
    const originGroupArgs = frontDoorOriginGroupCreateArgs("candidate");
    const originArgs = frontDoorOriginCreateArgs("candidate");
    const nsgArgs = appGatewayNsgRuleArgs();
    const waf = renderFrontDoorWafPolicy();
    const securityPolicy = renderFrontDoorSecurityPolicy([
      "candidate-endpoint-id",
      "primary-endpoint-id",
    ]);

    expect(originGroupArgs).toContain("--sample-size");
    expect(originGroupArgs).toContain("--successful-samples-required");
    expect(originArgs).toContain("--origin-host-header");
    expect(originArgs).not.toContain("--certificate-name-check-enabled");
    expect(nsgArgs).toContain("AzureFrontDoor.Backend");
    expect(nsgArgs).toContain("80");
    expect(nsgArgs).toContain(
      "uh-unrealhands-dev-acukmd-application-gateway-nsg",
    );
    expect(waf.properties.customRules.rules[0]).toMatchObject({
      action: "Block",
      matchConditions: [
        {
          matchVariable: "RemoteAddr",
          operator: "IPMatch",
          negateCondition: true,
          matchValue: ["207.68.149.128/28"],
        },
      ],
    });
    expect(
      securityPolicy.properties.parameters.associations[0].domains,
    ).toEqual([{ id: "candidate-endpoint-id" }, { id: "primary-endpoint-id" }]);
  });

  it("uses each Entra application's API identifier for its delegated scope", () => {
    expect(entraIdentifierUri("candidate")).toBe(
      "api://9071e6b8-c981-4a11-b975-256cc4b7b841",
    );
    expect(entraIdentifierUri("primary")).toBe(
      "api://a43e0aee-2f24-4b80-91e5-b6eb3db972c0",
    );
  });

  it("keeps one isolated runtime services node warm", () => {
    const args = runtimeNodePoolAutoscalerArgs();

    expect(args).toContain("services");
    expect(args).toContain("--update-cluster-autoscaler");
    expect(
      args.slice(args.indexOf("--min-count"), args.indexOf("--min-count") + 2),
    ).toEqual(["--min-count", "1"]);
    expect(
      args.slice(args.indexOf("--max-count"), args.indexOf("--max-count") + 2),
    ).toEqual(["--max-count", "1"]);
  });

  it("renders isolated candidate configuration with Key Vault CSI", () => {
    const spc = renderSecretProviderClass("candidate", "runtime-client-id");
    const values = renderHelmValues("candidate", digest, "runtime-client-id");

    expect(spc).toContain("halo-ppe-entra-client-secret");
    expect(spc).toContain("halo-ppe-session-api-key");
    expect(spc).toContain("halo-ppe-trusted-identity-assertion");
    expect(values).toContain(`digest: ${digest}`);
    expect(values).toContain("serviceAccount:\n  create: false");
    expect(values).toContain("value: azure/gpt-5.6-sol");
    expect(values).toContain(
      "value: https://mortmain-openai2.openai.azure.com/",
    );
    expect(values).toContain("value: azure_workload_identity");
    expect(values).toContain("agentpool: services");
    expect(values).toContain("value: services");
    expect(values).toContain(
      "host: openhands-ppe-gsbxe2cef0d4gefc.b01.azurefd.net",
    );
    expect(values).toContain("clientId: 9071e6b8-c981-4a11-b975-256cc4b7b841");
    expect(values).toContain(
      "api://9071e6b8-c981-4a11-b975-256cc4b7b841/access_as_user",
    );
    expect(values).toContain("secretProviderClass: openhands-halo-secrets");
    expect(values).toContain(
      "name: OH_CONVERSATIONS_PATH\n      value: /home/openhands/conversations",
    );
    expect(values).toContain("claimName: openhands-halo-conversations");
    expect(values).toContain("name: migrate-conversations");
    expect(values).toContain(
      "cp -R /legacy/agent-canvas/conversations/. /conversations/",
    );
    expect(values).toContain('name: DO_NOT_TRACK\n      value: "1"');
    expect(values).toContain('name: VITE_DO_NOT_TRACK\n      value: "1"');
    expect(values).toContain(
      'name: AGENT_CANVAS_DISABLE_TELEMETRY\n      value: "1"',
    );
    expect(values).toContain("automountServiceAccountToken: true");
    expect(values).toContain("name: OH_TRUSTED_IDENTITY_ASSERTION_SECRET");
    expect(values).toContain(
      "name: SANDBOX_SERVER_URL\n      value: http://openhands-sandbox-server:3000",
    );
    expect(values).toContain(
      "name: AGENT_CANVAS_CLOUD_URL\n      value: https://openhands-ppe-gsbxe2cef0d4gefc.b01.azurefd.net",
    );
    expect(values).toContain(
      "name: AGENT_CANVAS_SANDBOX_RUNTIME_NAMESPACE\n      value: openhands-halo-ppe",
    );
    expect(values).toContain(
      "name: AGENT_CANVAS_SANDBOX_RUNTIME_NAME_PREFIX\n      value: openhands-sandbox",
    );
    expect(values).not.toContain("AGENT_CANVAS_WORKSPACE_RUNTIME_NAMESPACE");
    expect(values).not.toContain("halo-primary-entra-client-secret");
  });

  it("renders a passwordless workload-identity Sandbox Server", () => {
    const resources = renderSandboxServerResources(
      "candidate",
      `sha256:${"b".repeat(64)}`,
      "runtime-client-id",
    );

    expect(resources).toContain("kind: Deployment");
    expect(resources).toContain("name: openhands-sandbox-server");
    expect(resources).toContain(
      "image: uhunrealhaacukmdbkacr.azurecr.io/openhands-sandbox-server@sha256:",
    );
    expect(resources).toContain('azure.workload.identity/use: "true"');
    expect(resources).toContain("serviceAccountName: openhands-halo");
    expect(resources).toContain(
      "name: AZURE_CLIENT_ID\n              value: runtime-client-id",
    );
    expect(resources).toContain(
      'name: DB_AZURE_IDENTITY\n              value: "true"',
    );
    expect(resources).toContain(
      "name: DB_HOST\n              value: uh-halo-pg-acukmdbk.postgres.database.azure.com",
    );
    expect(resources).toContain(
      "name: DB_NAME\n              value: openhands_halo_ppe",
    );
    expect(resources).toContain(
      "name: DB_USER\n              value: openhands-halo-ppe-runtime-mi",
    );
    expect(resources).toContain(
      "name: DB_SSL_MODE\n              value: require",
    );
    expect(resources).toContain(
      "name: LLM_AUTH_TYPE\n              value: azure_workload_identity",
    );
    expect(resources).toContain(
      'name: HIDE_LLM_SETTINGS\n              value: "true"',
    );
    expect(resources).toContain(
      'name: OH_ALLOW_USER_LLM_CONFIGURATION\n              value: "false"',
    );
    expect(resources).toContain(
      "name: OH_SANDBOX_SANDBOX_URL_PATTERN\n              value: https://openhands-ppe-gsbxe2cef0d4gefc.b01.azurefd.net/sandboxes/{sandbox_name}",
    );
    expect(resources).toContain(
      "name: OH_SANDBOX_CLAIM_NAME_PREFIX\n              value: openhands-sandbox",
    );
    expect(resources).not.toContain("DB_PASS");
    expect(resources).toContain(
      "name: OH_TRUSTED_IDENTITY_ASSERTION_ISSUER\n              value: openhands-halo-bff",
    );
    expect(resources).toContain("containerPort: 3000");
    expect(resources).toContain("path: /ready");
    expect(resources).toContain("kind: Service");
  });

  it("renders isolated agent-sandbox resources for each environment", () => {
    const resources = renderAgentSandboxResources("candidate");

    expect(resources).toContain(
      "apiVersion: extensions.agents.x-k8s.io/v1beta1",
    );
    expect(resources).toContain("kind: SandboxTemplate");
    expect(resources).toContain("namespace: openhands-halo-ppe");
    expect(resources).toContain("envVarsInjectionPolicy: Allowed");
    expect(resources).toContain(
      "image: ghcr.io/openhands/agent-server:1.37.1-python",
    );
    expect(resources).toContain(
      "storageClassName: openhands-halo-workspace-disk",
    );
    expect(resources).toContain("storage: 50Gi");
    expect(resources).toContain("kind: SandboxWarmPool");
    expect(resources).toContain("replicas: 0");
    expect(resources).toContain("name: openhands-pool");
    expect(resources).toContain(
      "app.kubernetes.io/name: openhands-sandbox-server",
    );
    expect(resources).toContain("app.kubernetes.io/name: agent-canvas");
    expect(resources).toContain('resources: ["sandboxclaims"]');
    expect(resources).toContain('verbs: ["get", "list", "watch", "patch"]');
    expect(resources).toContain("name: openhands-halo");
  });

  it("creates private Entra-only PostgreSQL and bootstraps runtime roles", () => {
    const bootstrapIdentity = {
      name: "openhands-halo-postgres-bootstrap-mi",
      principalId: "bootstrap-object-id",
    };
    const args = postgresServerCreateArgs(
      bootstrapIdentity,
      "/subscriptions/sub/resourceGroups/rg/providers/Microsoft.Network/virtualNetworks/vnet/subnets/postgres",
      "/subscriptions/sub/resourceGroups/rg/providers/Microsoft.Network/privateDnsZones/halo.private.postgres.database.azure.com",
    );
    const job = renderPostgresBootstrapJob({
      candidate: { principalId: "candidate-object-id" },
      primary: { principalId: "primary-object-id" },
    });

    expect(args).toContain("Standard_D2ads_v5");
    expect(args).toContain("--microsoft-entra-auth");
    expect(args).toContain("Enabled");
    expect(args).toContain("--password-auth");
    expect(args).toContain("Disabled");
    expect(args).toContain("bootstrap-object-id");
    expect(args).toContain("--subnet");
    expect(args).toContain("--private-dns-zone");
    expect(job).toContain("serviceAccountName: halo-postgres-bootstrap");
    expect(job).toContain("--resource-type oss-rdbms");
    expect(job).toContain(
      "pgaadauth_create_principal_with_oid('openhands-halo-ppe-runtime-mi', 'candidate-object-id', 'service', false, false)",
    );
    expect(job).toContain(
      "pgaadauth_create_principal_with_oid('openhands-halo-primary-runtime-mi', 'primary-object-id', 'service', false, false)",
    );
    expect(job).toContain(
      'ALTER DATABASE openhands_halo_ppe OWNER TO "openhands-halo-ppe-runtime-mi"',
    );
    expect(job).toContain(
      'GRANT USAGE, CREATE ON SCHEMA public TO "openhands-halo-ppe-runtime-mi"',
    );
    expect(job).toContain(
      'GRANT USAGE, CREATE ON SCHEMA public TO "openhands-halo-primary-runtime-mi"',
    );
    expect(job).not.toContain("DB_PASS");
  });

  it("uses retained Azure Files storage for conversation state", () => {
    const storageClass = renderConversationStorageClass();
    const pvc = renderConversationPvc("candidate");

    expect(storageClass).toContain("provisioner: file.csi.azure.com");
    expect(storageClass).toContain("reclaimPolicy: Retain");
    expect(storageClass).toContain("skuName: Standard_LRS");
    expect(pvc).toContain("namespace: openhands-halo-ppe");
    expect(pvc).toContain("accessModes:\n    - ReadWriteMany");
    expect(pvc).toContain("storageClassName: openhands-halo-azurefile");
    expect(pvc).toContain("storage: 5Gi");
  });

  it("uses retained Azure Disks for sandbox workspaces", () => {
    const storageClass = renderWorkspaceStorageClass();

    expect(storageClass).toContain("provisioner: disk.csi.azure.com");
    expect(storageClass).toContain("reclaimPolicy: Retain");
    expect(storageClass).toContain("skuName: StandardSSD_LRS");
    expect(storageClass).toContain("volumeBindingMode: WaitForFirstConsumer");
  });
});
