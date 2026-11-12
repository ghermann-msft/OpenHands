// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  appGatewayNsgRuleArgs,
  buildDigestFromPodList,
  buildNodePoolCreateArgs,
  entraIdentifierUri,
  frontDoorOriginCreateArgs,
  frontDoorOriginGroupCreateArgs,
  imageReference,
  normalizeDigest,
  renderArcControllerValues,
  renderArcRunnerRbac,
  renderArcRunnerValues,
  renderBuildJob,
  renderConversationPvc,
  renderConversationStorageClass,
  renderFrontDoorSecurityPolicy,
  renderFrontDoorWafPolicy,
  renderHelmValues,
  renderSecretProviderClass,
  renderWorkspaceRuntimeRbac,
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
    expect(job).toContain(`OPENHANDS_BUILD_GIT_SHA=${commit}`);
    expect(job).toContain(
      "AGENT_SERVER_SDK_GIT_REPOSITORY=https://github.com/ghermann-msft/software-agent-sdk.git",
    );
    expect(job).toContain(
      "AGENT_SERVER_SDK_GIT_REF=9908eb16d718397a4f562192a36b0193b5dcb81b",
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

  it("reads the immutable digest reported by the completed build container", () => {
    expect(
      buildDigestFromPodList({
        items: [
          {
            status: {
              containerStatuses: [
                {
                  name: "buildkit",
                  state: { terminated: { message: digest } },
                },
              ],
            },
          },
        ],
      }),
    ).toBe(digest);
    expect(() => buildDigestFromPodList({ items: [] })).toThrow(
      /did not publish an immutable image digest/,
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
    expect(values).toContain(
      "name: AGENT_CANVAS_WORKSPACE_RUNTIME_NAMESPACE\n      value: openhands-halo-ppe",
    );
    expect(values).toContain(
      `name: AGENT_CANVAS_WORKSPACE_RUNTIME_IMAGE\n      value: uhunrealhaacukmdbkacr.azurecr.io/openhands-halo@${digest}`,
    );
    expect(values).toContain(
      "name: AGENT_CANVAS_WORKSPACE_STORAGE_CLASS\n      value: openhands-halo-workspace-disk",
    );
    expect(values).not.toContain("halo-primary-entra-client-secret");
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

  it("uses retained Azure Disks and namespace-scoped runtime permissions", () => {
    const storageClass = renderWorkspaceStorageClass();
    const rbac = renderWorkspaceRuntimeRbac("candidate");

    expect(storageClass).toContain("provisioner: disk.csi.azure.com");
    expect(storageClass).toContain("reclaimPolicy: Retain");
    expect(storageClass).toContain("skuName: StandardSSD_LRS");
    expect(storageClass).toContain("volumeBindingMode: WaitForFirstConsumer");
    expect(rbac).toContain("namespace: openhands-halo-ppe");
    expect(rbac).toContain(
      'resources: ["configmaps", "persistentvolumeclaims", "services"]',
    );
    expect(rbac).toContain('resources: ["deployments"]');
    expect(rbac).toContain(
      'verbs: ["create", "delete", "get", "list", "patch"]',
    );
    expect(rbac).not.toContain("ClusterRole");
  });
});
