// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  acrTrustedServicesUpdateArgs,
  appGatewayNsgRuleArgs,
  aksApiServerAuthorizedIpUpdateArgs,
  aksNatGatewaySubnets,
  aksNatGatewayUpdateArgs,
  buildDigestsFromPodList,
  buildNodePoolCreateArgs,
  entraIdentifierUri,
  externalImageReference,
  frontDoorOriginCreateArgs,
  frontDoorOriginGroupCreateArgs,
  imageReference,
  natGatewayCreateArgs,
  natGatewayPublicIpCreateArgs,
  natGatewaySubnetUpdateArgs,
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
  renderSandboxSpecBootstrapConfigMap,
  renderWorkspaceStorageClass,
  renderWindowsRuntimeImport,
  renderWindowsRuntimePreflight,
  runtimeNodePoolAutoscalerArgs,
  validateWindowsRuntimeNodePool,
  validateNatGatewayPublicIp,
  validateBuildNodePool,
  validateWindowsNodePoolName,
  windowsRuntimeTemplateName,
  windowsRuntimeNodePoolCreateArgs,
  windowsRuntimeImageFromKubectlResult,
  windowsRuntimeImportTag,
  windowsPreflightJobResult,
  parseRollbackDigests,
} from "../../scripts/halo-deploy.mjs";

const digest = `sha256:${"a".repeat(64)}`;
const commit = "84d224f45e7647c3a04d4b8ac4af47af22a23b12";

describe("Halo deployment automation", () => {
  it("configures a cluster-owned NAT Gateway for every AKS subnet", () => {
    expect(natGatewayPublicIpCreateArgs()).toEqual(
      expect.arrayContaining([
        "uh-unrealhands-dev-egress-pip",
        "Standard",
        "Static",
        "1",
        "2",
        "3",
      ]),
    );
    expect(natGatewayCreateArgs()).toEqual(
      expect.arrayContaining([
        "uh-unrealhands-dev-nat",
        "uh-unrealhands-dev-egress-pip",
        "10",
      ]),
    );
    expect(
      validateNatGatewayPublicIp({
        sku: { name: "Standard" },
        publicIPAllocationMethod: "Static",
        zones: ["1", "2", "3"],
        ipAddress: "4.148.149.254",
      }),
    ).toBe("4.148.149.254/32");
    expect(() =>
      validateNatGatewayPublicIp({
        sku: { name: "Basic" },
        publicIPAllocationMethod: "Dynamic",
        ipAddress: "4.148.149.254",
      }),
    ).toThrow(/zone-redundant Standard static/);
    expect(natGatewaySubnetUpdateArgs("aks-linux")).toEqual(
      expect.arrayContaining([
        "uh-unrealhands-dev-acukmd-vnet",
        "aks-linux",
        "uh-unrealhands-dev-nat",
      ]),
    );
    expect(aksNatGatewaySubnets()).toEqual([
      "aks-system",
      "aks-linux",
      "aks-windows",
    ]);
    expect(aksApiServerAuthorizedIpUpdateArgs()).toEqual(
      expect.arrayContaining([
        "aks-unrealhands-dev",
        "207.68.149.128/28,4.148.149.254/32",
      ]),
    );
    expect(aksNatGatewayUpdateArgs()).toEqual(
      expect.arrayContaining(["aks-unrealhands-dev", "userAssignedNATGateway"]),
    );
    expect(acrTrustedServicesUpdateArgs()).toEqual(
      expect.arrayContaining([
        "uhunrealhaacukmdbkacr",
        "--allow-trusted-services",
        "true",
      ]),
    );
    expect(acrTrustedServicesUpdateArgs()).not.toContain("--default-action");
  });

  it("requires immutable image digests", () => {
    expect(normalizeDigest(digest)).toBe(digest);
    expect(() => normalizeDigest("84d224f45")).toThrow(/immutable sha256/);
    expect(imageReference("registry.example", "openhands-halo", digest)).toBe(
      `registry.example/openhands-halo@${digest}`,
    );
    expect(
      externalImageReference("ghcr.io/openhands/agent-server", digest),
    ).toBe(`ghcr.io/openhands/agent-server@${digest}`);
    expect(() =>
      externalImageReference("ghcr.io/openhands/agent-server:latest", digest),
    ).toThrow(/repository without a tag/);
  });

  it("uses the configured Windows profile template for promotion", () => {
    expect(windowsRuntimeTemplateName()).toBe(
      "openhands-agent-server-windows-2025",
    );
  });

  it("renders an isolated privileged cached build for the exact commit", () => {
    const job = renderBuildJob({ commit });

    expect(job).toContain(`git checkout --detach ${commit}`);
    expect(job).toContain(
      "git checkout --detach 240128e80e5e9aa1e4d3a7dae0e38357313662c9",
    );
    expect(job).toContain(`OPENHANDS_BUILD_GIT_SHA=${commit}`);
    expect(job).toContain(
      "--opt build-arg:VITE_HOSTED_PROFILE_SKILL_ALLOW_LIST=true",
    );
    expect(job).toContain("containers/app/Dockerfile");
    expect(job).toContain("--opt target=openhands-sandbox-server");
    expect(job).toContain("containers/sandbox/Dockerfile");
    expect(job).toContain(
      "name=uhunrealhaacukmdbkacr.azurecr.io/openhands-sandbox-runtime:",
    );
    expect(job).toContain(
      "name=uhunrealhaacukmdbkacr.azurecr.io/openhands-sandbox-server:",
    );
    expect(job).toContain(
      "name=uhunrealhaacukmdbkacr.azurecr.io/openhands-agent-server:",
    );
    expect(job).toContain(
      "git checkout --detach 2767366da92681ab9c937afb44a2c23d9ae929e9",
    );
    expect(job).toContain(
      "filename=openhands-agent-server/openhands/agent_server/docker/Dockerfile",
    );
    expect(job).toContain("--opt target=binary");
    expect(job).toContain(
      "AGENT_SERVER_SDK_GIT_REPOSITORY=https://github.com/ghermann-msft/software-agent-sdk.git",
    );
    expect(job).toContain(
      "AGENT_SERVER_SDK_GIT_REF=2767366da92681ab9c937afb44a2c23d9ae929e9",
    );
    expect(job).toContain(
      "SOFTWARE_AGENT_SDK_REPOSITORY=https://github.com/ghermann-msft/software-agent-sdk.git",
    );
    expect(job).toContain(
      "SOFTWARE_AGENT_SDK_REF=2767366da92681ab9c937afb44a2c23d9ae929e9",
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

  it("reads all immutable digests reported by the completed build container", () => {
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
                        agentServer: `sha256:${"c".repeat(64)}`,
                        sandboxServer: `sha256:${"b".repeat(64)}`,
                        sandboxRuntime: `sha256:${"d".repeat(64)}`,
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
      agentServer: `sha256:${"c".repeat(64)}`,
      sandboxServer: `sha256:${"b".repeat(64)}`,
      sandboxRuntime: `sha256:${"d".repeat(64)}`,
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
      'resources: ["sandboxtemplates", "sandboxwarmpools", "sandboxclaims"]',
    );
    expect(rbac).toContain(
      'verbs: ["create", "delete", "get", "list", "patch", "update", "watch"]',
    );
    expect(rbac).toContain('resources: ["sandboxes"]');
    expect(rbac).toContain('verbs: ["get", "list", "watch", "patch"]');
    expect(rbac).toContain(
      'resources: ["pods", "persistentvolumeclaims", "events"]',
    );
    expect(rbac).toContain('verbs: ["get", "list", "watch"]');
    expect(rbac).toContain("namespace: openhands-halo-ppe");
    expect(rbac).toContain("namespace: openhands-halo-primary");
    expect(rbac).not.toContain("ClusterRoleBinding");
  });

  it("defines and validates the warm build pool boundary", () => {
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
        minCount: 1,
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
        minCount: 1,
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

  it("defines and validates the native Windows Server 2025 runtime pool", () => {
    const args = windowsRuntimeNodePoolCreateArgs();

    expect(args).toContain("halo25");
    expect(args).toContain("Windows");
    expect(args).toContain("Windows2025");
    expect(args).toContain("Standard_D8s_v5");
    expect(args).toContain("0");
    expect(args).toContain("3");
    expect(args).toContain("unrealhands.io/pool=halo-windows:NoSchedule");
    expect(args).toContain("disabled");
    expect(args).toContain(
      "/subscriptions/3956877a-1e3c-4990-aba7-7481b5d99a60/resourceGroups/rg-unrealhands-dev/providers/Microsoft.Network/virtualNetworks/uh-unrealhands-dev-acukmd-vnet/subnets/aks-windows",
    );

    expect(() =>
      validateWindowsRuntimeNodePool({
        mode: "User",
        osType: "Windows",
        osSku: "Windows2025",
        vmSize: "Standard_D8s_v5",
        enableAutoScaling: true,
        minCount: 0,
        maxCount: 3,
        nodeLabels: {
          "unrealhands.io/pool": "halo-windows",
        },
        nodeTaints: ["unrealhands.io/pool=halo-windows:NoSchedule"],
        securityProfile: { sshAccess: "Disabled" },
      }),
    ).not.toThrow();
    expect(() =>
      validateWindowsRuntimeNodePool({
        mode: "User",
        osType: "Linux",
        osSku: "Ubuntu",
        vmSize: "Standard_D8s_v5",
        enableAutoScaling: true,
        minCount: 0,
        maxCount: 3,
        nodeLabels: {
          "unrealhands.io/pool": "halo-windows",
        },
        nodeTaints: ["unrealhands.io/pool=halo-windows:NoSchedule"],
        securityProfile: { sshAccess: "Disabled" },
      }),
    ).toThrow(/osType=Windows/);
  });

  it("rejects Windows node pool names that AKS cannot create", () => {
    expect(validateWindowsNodePoolName("halo25")).toBe("halo25");
    expect(() => validateWindowsNodePoolName("halowindows")).toThrow(
      /at most 6 characters/,
    );
    expect(() => validateWindowsNodePoolName("25halo")).toThrow(
      /start with a lowercase letter/,
    );
  });

  it("requires the immutable Windows runtime digest in rollback metadata", () => {
    const rollback = {
      canvas: digest,
      agentServer: digest,
      sandboxServer: digest,
      sandboxRuntime: digest,
      windowsRuntime: digest,
    };

    expect(parseRollbackDigests(JSON.stringify(rollback))).toEqual(rollback);
    delete (rollback as Partial<typeof rollback>).windowsRuntime;
    expect(() => parseRollbackDigests(JSON.stringify(rollback))).toThrow(
      "Primary rollback metadata is missing or invalid",
    );
  });

  it("uses the candidate Windows digest only when legacy primary has no Windows template", () => {
    expect(
      windowsRuntimeImageFromKubectlResult(
        {
          status: 1,
          stdout: "",
          stderr:
            'Error from server (NotFound): sandboxtemplates.extensions.agents.x-k8s.io "openhands-agent-server-windows-2025" not found',
        },
        digest,
      ),
    ).toBe(
      `uhunrealhaacukmdbkacr.azurecr.io/openhands-agent-server-windows@${digest}`,
    );
    expect(() =>
      windowsRuntimeImageFromKubectlResult(
        {
          status: 1,
          stdout: "",
          stderr: "Error from server (Forbidden)",
        },
        digest,
      ),
    ).toThrow(/Forbidden/);
  });

  it("renders Linux and native Windows curated sandbox profiles", () => {
    const windowsDigest = `sha256:${"e".repeat(64)}`;
    const resources = renderAgentSandboxResources(
      "candidate",
      digest,
      windowsDigest,
    );

    expect(resources).toContain("name: openhands-agent-server");
    expect(resources).toContain(
      "name: openhands-agent-server-linux-high-memory",
    );
    expect(resources).toContain("name: openhands-agent-server-windows-2025");
    expect(resources).toContain(
      "name: openhands-agent-server-windows-high-memory",
    );
    expect(resources).toContain("name: openhands-agent-server-windows-build");
    expect(resources).toContain(
      `image: uhunrealhaacukmdbkacr.azurecr.io/openhands-agent-server-windows@${windowsDigest}`,
    );
    expect(resources).toContain("kubernetes.io/os: windows");
    expect(resources).toContain("agentpool: halo25");
    expect(resources).toContain("workingDir: 'C:\\workspace\\project'");
    expect(resources).toContain("mountPath: 'C:\\workspace'");
    expect(resources).not.toContain("name: OH_SESSION_API_KEYS_0");
    expect(resources).not.toContain("name: OH_SECRET_KEY");
    expect(resources).toContain(
      'node.kubernetes.io/windows-build: "10.0.26100"',
    );
    expect(resources).toContain("replicas: 0");
    expect(resources).toContain(
      "storageClassName: openhands-halo-windows-workspace-disk",
    );
    expect(resources).toContain(
      "name: openhands-state\n          persistentVolumeClaim:\n            claimName: openhands-halo-conversations",
    );
    expect(resources).toContain(
      "name: openhands-state\n              mountPath: 'C:\\OpenHands'",
    );
    const windowsTemplate = resources
      .split("name: openhands-agent-server-windows-2025", 2)[1]
      .split("---", 1)[0];
    expect(windowsTemplate).not.toContain("subPath");
    expect(resources).toContain('cpu: "8"');
    expect(resources).toContain("memory: 32Gi");
    const windowsTemplates = resources.split(
      "name: openhands-agent-server-windows-2025",
    )[1];
    expect(windowsTemplates).not.toContain("containerPort: 8001");
  });

  it("imports the exact public Windows digest into ACR with workload identity", () => {
    const job = renderWindowsRuntimeImport(digest);

    expect(windowsRuntimeImportTag(digest)).toBe(`sha256-${"a".repeat(64)}`);
    expect(job).toContain(
      `--source ghcr.io/ghermann-msft/agent-server@${digest}`,
    );
    expect(job).toContain(
      `--image openhands-agent-server-windows:sha256-${"a".repeat(64)}`,
    );
    expect(job).toContain(`--name openhands-agent-server-windows@${digest}`);
    expect(job).toContain(`test "$imported_digest" = "${digest}"`);
    expect(job).toContain("serviceAccountName: halo-windows-runtime-importer");
    expect(job).toContain('azure.workload.identity/use: "true"');
    expect(job).not.toContain("imagePullSecrets:");
  });

  it("preflights the exact ACR Windows image and Workload Identity token", () => {
    const job = renderWindowsRuntimePreflight("candidate", digest);

    expect(job).toContain(
      `image: uhunrealhaacukmdbkacr.azurecr.io/openhands-agent-server-windows@${digest}`,
    );
    expect(job).toContain("activeDeadlineSeconds: 1800");
    expect(job).toContain("agentpool: halo25");
    expect(job).toContain(
      "C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe",
    );
    expect(job).toContain('node.kubernetes.io/windows-build: "10.0.26100"');
    expect(job).toContain('azure.workload.identity/use: "true"');
    expect(job).toContain("serviceAccountName: openhands-halo");
    expect(job).toContain("AZURE_FEDERATED_TOKEN_FILE");
    expect(job).not.toContain("imagePullSecrets:");
  });

  it("surfaces Windows preflight failure details without waiting for the deadline", () => {
    expect(
      windowsPreflightJobResult({
        status: {
          conditions: [
            {
              type: "Failed",
              status: "True",
              reason: "DeadlineExceeded",
              message: "Job was active longer than specified deadline",
            },
          ],
        },
      }),
    ).toEqual({
      status: "failed",
      detail:
        "DeadlineExceeded: Job was active longer than specified deadline",
    });
  });

  it("seeds separate workspace disks and durable Azure Files paths", () => {
    const windowsDigest = `sha256:${"e".repeat(64)}`;
    const configMap = renderSandboxSpecBootstrapConfigMap(
      "candidate",
      digest,
      windowsDigest,
    );

    expect(configMap).toContain('"working_dir": "/workspace/project"');
    expect(configMap).toContain('"workspace_mount_path": "/workspace"');
    expect(configMap).toContain('"durable_state_dir": "/openhands"');
    expect(configMap).toContain('"durable_mount_path": "/openhands"');
    expect(configMap).toContain('"startup_timeout_seconds": 300');
    expect(configMap).toContain(
      '"OH_CONVERSATIONS_PATH": "/openhands/conversations"',
    );
    expect(configMap).toContain(
      '"OH_CONVERSATION_WORKTREE_ROOT": "/workspace/worktrees"',
    );
    expect(configMap).toContain('"working_dir": "C:\\\\workspace\\\\project"');
    expect(configMap).toContain(
      '"workspace_mount_path": "C:\\\\workspace"',
    );
    expect(configMap).toContain(
      '"durable_state_dir": "C:\\\\OpenHands\\\\{sandbox_id}"',
    );
    expect(configMap).toContain(
      '"durable_mount_path": "C:\\\\OpenHands"',
    );
    expect(configMap).toContain('"operating_system": "windows"');
    expect(configMap).toContain('"availability": "available"');
    expect(configMap).toContain('"startup_timeout_seconds": 600');
    expect(configMap).toContain(
      '"shell": [\n          "powershell.exe",\n          "-NoLogo",\n          "-NoProfile"\n        ]',
    );
    expect(configMap).toContain('"cpu_cores": 4');
    expect(configMap).toContain('"memory_gib": 8');
    expect(configMap).toContain(
      '"node.kubernetes.io/windows-build": "10.0.26100"',
    );
    expect(configMap).toContain('"initial_env": {');
    expect(configMap).toContain('"OH_ENABLE_VNC": "0"');
    expect(configMap).toContain('"LOG_JSON": "true"');
    expect(configMap).toContain('"PYTHONUNBUFFERED": "1"');
    expect(configMap).toContain('"OH_SANDBOX_OPERATING_SYSTEM": "windows"');
    expect(configMap).not.toContain('"state_path"');
    expect(configMap).not.toContain("OH_SESSION_API_KEYS_0");
    expect(configMap).not.toContain("OH_SECRET_KEY");
    expect(configMap).toContain(
      '"OH_CONVERSATION_WORKTREE_ROOT": "C:\\\\workspace\\\\worktrees"',
    );
    expect(configMap).toContain(
      '"workspace_storage_class": "openhands-halo-windows-workspace-disk"',
    );
    expect(configMap).toContain(
      '"durable_storage_class": "openhands-halo-azurefile"',
    );
    expect(configMap).toContain('"durable_storage_size": null');
    expect(configMap).toContain(
      '"durable_volume_claim_name": "openhands-halo-conversations"',
    );
    expect(configMap).toContain('"durable_sub_path_template": "{sandbox_id}"');
    expect(configMap).toContain(
      '"OH_CONVERSATIONS_PATH": "C:\\\\OpenHands\\\\{sandbox_id}\\\\conversations"',
    );
  });

  it("renders an NTFS workspace storage class for Windows sandboxes", () => {
    const storageClass = renderWorkspaceStorageClass("windows");

    expect(storageClass).toContain(
      "name: openhands-halo-windows-workspace-disk",
    );
    expect(storageClass).toContain("skuName: Premium_LRS");
    expect(storageClass).toContain("csi.storage.k8s.io/fstype: ntfs");
    expect(storageClass).toContain("volumeBindingMode: WaitForFirstConsumer");
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
      action: "Allow",
      matchConditions: [
        {
          matchVariable: "RemoteAddr",
          operator: "IPMatch",
          negateCondition: false,
          matchValue: ["4.148.149.254/32"],
        },
      ],
    });
    expect(waf.properties.customRules.rules[1]).toMatchObject({
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

  it("keeps runtime services capacity and rollout headroom", () => {
    const args = runtimeNodePoolAutoscalerArgs();

    expect(args).toContain("services");
    expect(args).toContain("--update-cluster-autoscaler");
    expect(
      args.slice(args.indexOf("--min-count"), args.indexOf("--min-count") + 2),
    ).toEqual(["--min-count", "2"]);
    expect(
      args.slice(args.indexOf("--max-count"), args.indexOf("--max-count") + 2),
    ).toEqual(["--max-count", "3"]);
  });

  it("renders isolated candidate configuration with Key Vault CSI", () => {
    const spc = renderSecretProviderClass("candidate", "runtime-client-id");
    const values = renderHelmValues("candidate", digest, "runtime-client-id");

    expect(spc).toContain("halo-ppe-entra-client-secret");
    expect(spc).toContain("halo-ppe-session-api-key");
    expect(spc).toContain("halo-ppe-trusted-identity-assertion");
    expect(spc).toContain("halo-ppe-sandbox-jwt-secret");
    expect(spc).toContain("halo-ppe-github-app-client-id");
    expect(spc).toContain("halo-ppe-github-app-client-secret");
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
      'name: AGENT_CANVAS_EXTERNAL_SETTINGS_SHELL\n      value: "false"',
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
      `sha256:${"d".repeat(64)}`,
      "runtime-client-id",
      `sha256:${"e".repeat(64)}`,
    );

    expect(resources).toContain("kind: Deployment");
    expect(resources).toContain("name: openhands-sandbox-server");
    expect(resources).toContain(
      "image: uhunrealhaacukmdbkacr.azurecr.io/openhands-sandbox-server@sha256:",
    );
    expect(resources).toContain(
      "name: AGENT_SERVER_IMAGE\n              value: uhunrealhaacukmdbkacr.azurecr.io/openhands-sandbox-runtime@sha256:",
    );
    expect(resources).toContain(
      "name: OH_WINDOWS_AGENT_SERVER_IMAGE\n              value: uhunrealhaacukmdbkacr.azurecr.io/openhands-agent-server-windows@sha256:",
    );
    expect(resources).toContain(
      "name: OH_SANDBOX_SPEC_BOOTSTRAP_FILE\n              value: /etc/openhands/sandbox-specs.json",
    );
    expect(resources).toContain(
      "name: OH_HALO_DURABLE_STATE_PVC\n              value: openhands-halo-conversations",
    );
    expect(resources).toContain(
      'name: OH_APP_CONVERSATION_SANDBOX_STARTUP_TIMEOUT\n              value: "600"',
    );
    expect(resources).toContain(
      'name: OH_APP_CONVERSATION_SANDBOX_STARTUP_INACTIVITY_TIMEOUT\n              value: "120"',
    );
    expect(
      renderSandboxServerResources(
        "primary",
        `sha256:${"b".repeat(64)}`,
        `sha256:${"d".repeat(64)}`,
        "runtime-client-id",
        digest,
      ),
    ).not.toContain("OH_APP_CONVERSATION_SANDBOX_STARTUP_TIMEOUT");
    expect(resources).toContain(
      "name: sandbox-spec-bootstrap\n          configMap:\n            name: openhands-sandbox-spec-bootstrap",
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
      "name: FOUNDRY_WEB_SEARCH_MCP_ENDPOINT\n              value: https://azureaieastus21665416127.services.ai.azure.com/api/projects/studio-ai-agents-project/toolboxes/openhands-web-search/versions/1/mcp?api-version=v1",
    );
    expect(resources).toContain(
      "name: FOUNDRY_WEB_SEARCH_MCP_AUTH_TYPE\n              value: azure_workload_identity",
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
    expect(resources).toContain("name: JWT_SECRET");
    expect(resources).toContain("name: GITHUB_APP_CLIENT_ID");
    expect(resources).toContain("name: GITHUB_APP_CLIENT_SECRET");
    expect(resources).toContain(
      "name: GITHUB_APP_SLUG\n              value: openhands-halo-ppe",
    );
    expect(resources).toContain(
      "name: OH_GITHUB_OAUTH_CALLBACK_URL\n              value: https://openhands-ppe-gsbxe2cef0d4gefc.b01.azurefd.net/oauth/github/callback",
    );
    expect(resources).toContain(
      "name: OH_GITHUB_OAUTH_SUCCESS_URL\n              value: https://openhands-ppe-gsbxe2cef0d4gefc.b01.azurefd.net/settings/app",
    );
    expect(resources).toContain("containerPort: 3000");
    expect(resources).toContain("path: /ready");
    expect(resources).toContain("kind: Service");
  });

  it("renders isolated agent-sandbox resources for each environment", () => {
    const agentServerDigest = `sha256:${"c".repeat(64)}`;
    const windowsRuntimeDigest = `sha256:${"e".repeat(64)}`;
    const resources = renderAgentSandboxResources(
      "candidate",
      agentServerDigest,
      windowsRuntimeDigest,
    );

    expect(resources).toContain(
      "apiVersion: extensions.agents.x-k8s.io/v1beta1",
    );
    expect(resources).toContain("kind: SandboxTemplate");
    expect(resources).toContain("volumeClaimTemplatesPolicy: Overrides");
    expect(resources).toContain("namespace: openhands-halo-ppe");
    expect(resources).toContain("envVarsInjectionPolicy: Allowed");
    expect(resources).toContain("service: true");
    expect(resources).toContain(
      `image: uhunrealhaacukmdbkacr.azurecr.io/openhands-agent-server@${agentServerDigest}`,
    );
    expect(resources).not.toContain("AGENT_CANVAS_BACKEND");
    expect(resources).not.toContain("agent-canvas-session-key");
    expect(resources).toContain("workingDir: /workspace/project");
    expect(resources).toContain(
      "name: openhands-state\n              mountPath: /openhands\n              subPathExpr: $(OH_SANDBOX_ID)",
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
    expect(resources).toContain(
      'resources: ["pods", "persistentvolumeclaims", "events"]',
    );
    expect(resources).toContain('verbs: ["get", "list", "watch"]');
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
