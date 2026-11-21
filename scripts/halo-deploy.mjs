import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { isIP } from "node:net";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(scriptDir, "..");
const config = JSON.parse(
  readFileSync(join(projectRoot, "deploy", "halo", "config.json"), "utf8"),
);
const defaults = JSON.parse(
  readFileSync(join(projectRoot, "config", "defaults.json"), "utf8"),
);

function quote(value) {
  return JSON.stringify(String(value));
}

let azureCliPython;

function invocation(command, args) {
  if (process.platform !== "win32" || command !== "az") {
    return { file: command, args };
  }
  azureCliPython ??= resolve(
    dirname(
      execFileSync("where.exe", ["az.cmd"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
      })
        .trim()
        .split(/\r?\n/)[0],
    ),
    "..",
    "python.exe",
  );
  return {
    file: azureCliPython,
    args: ["-IBm", "azure.cli", ...args],
  };
}

function run(command, args, { capture = false, input } = {}) {
  const resolved = invocation(command, args);
  if (capture) {
    return execFileSync(resolved.file, resolved.args, {
      cwd: projectRoot,
      encoding: "utf8",
      input,
      stdio:
        input === undefined
          ? ["ignore", "pipe", "inherit"]
          : ["pipe", "pipe", "inherit"],
    }).trim();
  }
  execFileSync(resolved.file, resolved.args, {
    cwd: projectRoot,
    input,
    stdio: input === undefined ? "inherit" : ["pipe", "inherit", "inherit"],
  });
}

function tryRun(command, args) {
  const resolved = invocation(command, args);
  return spawnSync(resolved.file, resolved.args, {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function az(args, options) {
  return run("az", args, options);
}

function kubectl(args, options) {
  return run("kubectl", args, options);
}

function helm(args, options) {
  return run("helm", args, options);
}

function option(args, name, fallback = null) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

export function normalizeDigest(value) {
  const digest = String(value ?? "").trim();
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) {
    throw new Error(`Expected an immutable sha256 digest, received: ${digest}`);
  }
  return digest;
}

export function imageReference(loginServer, repository, digest) {
  return `${loginServer}/${repository}@${normalizeDigest(digest)}`;
}

export function externalImageReference(repository, digest) {
  const normalizedRepository = String(repository ?? "").trim();
  if (
    !normalizedRepository ||
    normalizedRepository.includes("@") ||
    /:[^/]+$/.test(normalizedRepository)
  ) {
    throw new Error(
      `Expected an image repository without a tag or digest, received: ${normalizedRepository}`,
    );
  }
  return `${normalizedRepository}@${normalizeDigest(digest)}`;
}

export function normalizeCommit(value, name = "commit") {
  const commit = String(value ?? "").trim();
  if (!/^[a-f0-9]{40}$/.test(commit)) {
    throw new Error(
      `Expected an immutable 40-character ${name}, received: ${commit}`,
    );
  }
  return commit;
}

export function parseRemoteBranchHead(output, repository, branch) {
  const expectedRef = `refs/heads/${branch}`;
  const matches = String(output ?? "")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.trim().split(/\s+/))
    .filter(([, ref]) => ref === expectedRef);
  if (matches.length !== 1) {
    throw new Error(
      `Could not resolve exactly one HEAD for ${repository} ${expectedRef}`,
    );
  }
  return normalizeCommit(matches[0][0], `${branch} branch HEAD`);
}

function resolveRemoteBranchHead(repository, branch) {
  return parseRemoteBranchHead(
    run("git", ["ls-remote", "--heads", repository, branch], {
      capture: true,
    }),
    repository,
    branch,
  );
}

function sourceDefinitions() {
  return {
    openhands: {
      repository: config.source.repository,
      branch: config.source.branch,
    },
    agentServer: {
      repository: config.source.agentServerSdkRepository,
      branch: config.source.agentServerSdkBranch,
    },
    sandboxServer: {
      repository: config.source.sandboxServerRepository,
      branch: config.source.sandboxServerBranch,
    },
  };
}

function resolveSourceHeads() {
  return Object.fromEntries(
    Object.entries(sourceDefinitions()).map(([name, source]) => [
      name,
      {
        ...source,
        commit: resolveRemoteBranchHead(source.repository, source.branch),
      },
    ]),
  );
}

function printResolvedSources(sources) {
  for (const [prefix, source] of [
    ["OPENHANDS", sources.openhands],
    ["AGENT_SERVER", sources.agentServer],
    ["SANDBOX_SERVER", sources.sandboxServer],
  ]) {
    console.log(`${prefix}_SOURCE_REPOSITORY=${source.repository}`);
    console.log(`${prefix}_SOURCE_BRANCH=${source.branch}`);
    console.log(`${prefix}_SOURCE_SHA=${source.commit}`);
  }
}

function identity(name) {
  return JSON.parse(
    az(
      [
        "identity",
        "show",
        "--resource-group",
        config.azure.resourceGroup,
        "--name",
        name,
        "--output",
        "json",
      ],
      { capture: true },
    ),
  );
}

function ensureIdentity(name) {
  const existing = tryRun("az", [
    "identity",
    "show",
    "--resource-group",
    config.azure.resourceGroup,
    "--name",
    name,
    "--output",
    "json",
  ]);
  if (existing.status === 0) return JSON.parse(existing.stdout);
  return JSON.parse(
    az(
      [
        "identity",
        "create",
        "--resource-group",
        config.azure.resourceGroup,
        "--name",
        name,
        "--location",
        config.azure.location,
        "--output",
        "json",
      ],
      { capture: true },
    ),
  );
}

function ensureRole({ principalId, role, scope }) {
  const existing = az(
    [
      "role",
      "assignment",
      "list",
      "--assignee-object-id",
      principalId,
      "--scope",
      scope,
      "--query",
      `[?roleDefinitionName=='${role}'].id | [0]`,
      "--output",
      "tsv",
    ],
    { capture: true },
  );
  if (existing) return;
  az([
    "role",
    "assignment",
    "create",
    "--assignee-object-id",
    principalId,
    "--assignee-principal-type",
    "ServicePrincipal",
    "--role",
    role,
    "--scope",
    scope,
    "--output",
    "none",
  ]);
}

export function natGatewayPublicIpCreateArgs() {
  return [
    "network",
    "public-ip",
    "create",
    "--subscription",
    config.azure.subscriptionId,
    "--resource-group",
    config.azure.resourceGroup,
    "--name",
    config.network.publicIp,
    "--location",
    config.azure.location,
    "--sku",
    "Standard",
    "--allocation-method",
    "Static",
    "--zone",
    "1",
    "2",
    "3",
    "--output",
    "none",
  ];
}

export function natGatewayCreateArgs() {
  return [
    "network",
    "nat",
    "gateway",
    "create",
    "--subscription",
    config.azure.subscriptionId,
    "--resource-group",
    config.azure.resourceGroup,
    "--name",
    config.network.natGateway,
    "--location",
    config.azure.location,
    "--public-ip-addresses",
    config.network.publicIp,
    "--idle-timeout",
    String(config.network.idleTimeoutMinutes),
    "--output",
    "none",
  ];
}

export function validateNatGatewayPublicIp(publicIp) {
  if (
    publicIp.sku?.name !== "Standard" ||
    publicIp.publicIPAllocationMethod !== "Static" ||
    [...(publicIp.zones ?? [])].sort().join(",") !== "1,2,3"
  ) {
    throw new Error(
      `${config.network.publicIp} must be a zone-redundant Standard static public IP`,
    );
  }
  if (!publicIp.ipAddress) {
    throw new Error(
      `${config.network.publicIp} does not have an allocated IP address`,
    );
  }
  const cidr = `${publicIp.ipAddress}/32`;
  if (cidr !== config.network.publicIpCidr) {
    throw new Error(
      `Configured NAT Gateway CIDR ${config.network.publicIpCidr} does not match ${config.network.publicIp} (${publicIp.ipAddress})`,
    );
  }
  return cidr;
}

export function natGatewaySubnetUpdateArgs(subnet) {
  return [
    "network",
    "vnet",
    "subnet",
    "update",
    "--subscription",
    config.azure.subscriptionId,
    "--resource-group",
    config.azure.resourceGroup,
    "--vnet-name",
    config.network.vnet,
    "--name",
    subnet,
    "--nat-gateway",
    config.network.natGateway,
    "--output",
    "none",
  ];
}

export function aksNatGatewaySubnets() {
  return [...config.network.aksSubnets];
}

export function aksApiServerAuthorizedIpUpdateArgs() {
  return [
    "aks",
    "update",
    "--subscription",
    config.azure.subscriptionId,
    "--resource-group",
    config.azure.resourceGroup,
    "--name",
    config.azure.aksCluster,
    "--api-server-authorized-ip-ranges",
    config.network.apiServerAuthorizedCidrs.join(","),
    "--output",
    "none",
  ];
}

export function aksNatGatewayUpdateArgs() {
  return [
    "aks",
    "update",
    "--subscription",
    config.azure.subscriptionId,
    "--resource-group",
    config.azure.resourceGroup,
    "--name",
    config.azure.aksCluster,
    "--outbound-type",
    "userAssignedNATGateway",
    "--output",
    "none",
  ];
}

export function blobPrivateDnsLinkUpdateArgs() {
  const link = config.network.blobPrivateDnsLink;
  return [
    "network",
    "private-dns",
    "link",
    "vnet",
    "update",
    "--subscription",
    config.azure.subscriptionId,
    "--resource-group",
    link.resourceGroup,
    "--zone-name",
    link.zoneName,
    "--name",
    link.linkName,
    "--resolution-policy",
    link.resolutionPolicy,
    "--output",
    "none",
  ];
}

export function acrTrustedServicesUpdateArgs() {
  return [
    "acr",
    "update",
    "--resource-group",
    config.azure.resourceGroup,
    "--name",
    config.azure.acrName,
    "--allow-trusted-services",
    "true",
    "--output",
    "none",
  ];
}

function validateAzureOpenAi() {
  const account = JSON.parse(
    az(
      [
        "cognitiveservices",
        "account",
        "show",
        "--subscription",
        config.azureOpenAI.subscriptionId,
        "--resource-group",
        config.azureOpenAI.resourceGroup,
        "--name",
        config.azureOpenAI.accountName,
        "--output",
        "json",
      ],
      { capture: true },
    ),
  );
  if (account.properties?.endpoint !== config.azureOpenAI.endpoint) {
    throw new Error(
      `Azure OpenAI endpoint mismatch: expected ${config.azureOpenAI.endpoint}, found ${account.properties?.endpoint ?? "none"}`,
    );
  }
  const deployment = JSON.parse(
    az(
      [
        "cognitiveservices",
        "account",
        "deployment",
        "show",
        "--subscription",
        config.azureOpenAI.subscriptionId,
        "--resource-group",
        config.azureOpenAI.resourceGroup,
        "--name",
        config.azureOpenAI.accountName,
        "--deployment-name",
        config.azureOpenAI.deployment,
        "--output",
        "json",
      ],
      { capture: true },
    ),
  );
  if (
    deployment.properties?.provisioningState !== "Succeeded" ||
    deployment.properties?.model?.name !== config.azureOpenAI.deployment
  ) {
    throw new Error(
      `Azure OpenAI deployment ${config.azureOpenAI.deployment} is not a matching succeeded deployment`,
    );
  }
}

function ensureFederatedCredential({
  identityName,
  credentialName,
  namespace,
  serviceAccount,
}) {
  const existing = az(
    [
      "identity",
      "federated-credential",
      "list",
      "--resource-group",
      config.azure.resourceGroup,
      "--identity-name",
      identityName,
      "--query",
      `[?name=='${credentialName}'].name | [0]`,
      "--output",
      "tsv",
    ],
    { capture: true },
  );
  if (existing) return;
  const issuer = az(
    [
      "aks",
      "show",
      "--resource-group",
      config.azure.resourceGroup,
      "--name",
      config.azure.aksCluster,
      "--query",
      "oidcIssuerProfile.issuerUrl",
      "--output",
      "tsv",
    ],
    { capture: true },
  );
  az([
    "identity",
    "federated-credential",
    "create",
    "--resource-group",
    config.azure.resourceGroup,
    "--identity-name",
    identityName,
    "--name",
    credentialName,
    "--issuer",
    issuer,
    "--subject",
    `system:serviceaccount:${namespace}:${serviceAccount}`,
    "--audiences",
    "api://AzureADTokenExchange",
    "--output",
    "none",
  ]);
}

function ensureNamespaceAndServiceAccount(namespace, serviceAccount, clientId) {
  const namespaceYaml = kubectl(
    ["create", "namespace", namespace, "--dry-run=client", "-o", "yaml"],
    { capture: true },
  );
  kubectl(["apply", "-f", "-"], { input: namespaceYaml });
  kubectl(["apply", "-f", "-"], {
    input: `apiVersion: v1
kind: ServiceAccount
metadata:
  name: ${serviceAccount}
  namespace: ${namespace}
  annotations:
    azure.workload.identity/client-id: ${quote(clientId)}
`,
  });
}

export function buildNodePoolCreateArgs() {
  const build = config.build;
  return [
    "aks",
    "nodepool",
    "add",
    "--subscription",
    config.azure.subscriptionId,
    "--resource-group",
    config.azure.resourceGroup,
    "--cluster-name",
    config.azure.aksCluster,
    "--name",
    build.nodePool,
    "--mode",
    "User",
    "--os-type",
    "Linux",
    "--os-sku",
    "Ubuntu",
    "--node-vm-size",
    build.nodePoolVmSize,
    "--node-osdisk-type",
    build.nodePoolOsDiskType,
    "--node-osdisk-size",
    String(build.nodePoolOsDiskSizeGb),
    "--node-count",
    String(build.nodePoolMinCount),
    "--enable-cluster-autoscaler",
    "--min-count",
    String(build.nodePoolMinCount),
    "--max-count",
    String(build.nodePoolMaxCount),
    "--ssh-access",
    "disabled",
    "--labels",
    `${build.nodeTaintKey}=${build.nodeTaintValue}`,
    "--node-taints",
    `${build.nodeTaintKey}=${build.nodeTaintValue}:NoSchedule`,
    "--output",
    "none",
  ];
}

export function renderCoreDnsCustomConfigMap() {
  const entries = (config.network.privateDnsOverrides ?? []).map((entry) => {
    const hostname = String(entry.hostname ?? "")
      .trim()
      .toLowerCase();
    const labels = hostname.split(".");
    if (
      isIP(entry.address) !== 4 ||
      hostname.length > 253 ||
      labels.length < 2 ||
      labels.some(
        (label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label),
      )
    ) {
      throw new Error(
        `Invalid private DNS override: ${entry.address} ${entry.hostname}`,
      );
    }
    return `      ${entry.address} ${hostname}`;
  });
  return `apiVersion: v1
kind: ConfigMap
metadata:
  name: coredns-custom
  namespace: kube-system
data:
  halo-private-hosts.override: |
    hosts {
${entries.join("\n")}
      fallthrough
    }
`;
}

function ensurePrivateDnsOverrides() {
  kubectl(["apply", "-f", "-"], {
    input: renderCoreDnsCustomConfigMap(),
  });
  kubectl(["-n", "kube-system", "rollout", "restart", "deployment/coredns"]);
  kubectl([
    "-n",
    "kube-system",
    "rollout",
    "status",
    "deployment/coredns",
    "--timeout=5m",
  ]);
}

function subnetResourceId(subnet) {
  return `/subscriptions/${config.azure.subscriptionId}/resourceGroups/${config.azure.resourceGroup}/providers/Microsoft.Network/virtualNetworks/${config.network.vnet}/subnets/${subnet}`;
}

export function validateWindowsNodePoolName(name) {
  if (!/^[a-z][a-z0-9]{0,5}$/.test(name)) {
    throw new Error(
      `Windows AKS node pool name must start with a lowercase letter, use only lowercase letters or digits, and be at most 6 characters: ${name}`,
    );
  }
  return name;
}

export function windowsRuntimeNodePoolCreateArgs() {
  const runtime = config.windowsRuntime;
  validateWindowsNodePoolName(runtime.nodePool);
  return [
    "aks",
    "nodepool",
    "add",
    "--subscription",
    config.azure.subscriptionId,
    "--resource-group",
    config.azure.resourceGroup,
    "--cluster-name",
    config.azure.aksCluster,
    "--name",
    runtime.nodePool,
    "--mode",
    "User",
    "--os-type",
    "Windows",
    "--os-sku",
    runtime.osSku,
    "--node-vm-size",
    runtime.nodePoolVmSize,
    "--node-osdisk-type",
    runtime.nodePoolOsDiskType,
    "--node-osdisk-size",
    String(runtime.nodePoolOsDiskSizeGb),
    "--node-count",
    String(runtime.nodePoolMinCount),
    "--enable-cluster-autoscaler",
    "--min-count",
    String(runtime.nodePoolMinCount),
    "--max-count",
    String(runtime.nodePoolMaxCount),
    "--vnet-subnet-id",
    subnetResourceId(runtime.nodeSubnet),
    "--labels",
    `${runtime.nodeTaintKey}=${runtime.nodeTaintValue}`,
    `openhands.dev/pagefile-gib=${runtime.pagefileSizeGiB}`,
    "--node-taints",
    `${runtime.nodeTaintKey}=${runtime.nodeTaintValue}:NoSchedule`,
    "--ssh-access",
    "disabled",
    "--output",
    "none",
  ];
}

export function windowsRuntimeNodePoolAutoscalerArgs() {
  const runtime = config.windowsRuntime;
  return [
    "aks",
    "nodepool",
    "update",
    "--subscription",
    config.azure.subscriptionId,
    "--resource-group",
    config.azure.resourceGroup,
    "--cluster-name",
    config.azure.aksCluster,
    "--name",
    runtime.nodePool,
    "--update-cluster-autoscaler",
    "--min-count",
    String(runtime.nodePoolMinCount),
    "--max-count",
    String(runtime.nodePoolMaxCount),
    "--output",
    "none",
  ];
}

export function postgresServerCreateArgs(
  bootstrapIdentity,
  subnetId,
  privateDnsZoneId,
) {
  const postgres = config.postgres;
  return [
    "postgres",
    "flexible-server",
    "create",
    "--resource-group",
    postgres.resourceGroup,
    "--name",
    postgres.serverName,
    "--location",
    config.azure.location,
    "--sku-name",
    postgres.skuName,
    "--tier",
    postgres.tier,
    "--version",
    postgres.version,
    "--storage-size",
    String(postgres.storageSizeGb),
    "--storage-auto-grow",
    "Enabled",
    "--backup-retention",
    "7",
    "--zonal-resiliency",
    "Disabled",
    "--geo-redundant-backup",
    "Disabled",
    "--microsoft-entra-auth",
    "Enabled",
    "--password-auth",
    "Disabled",
    "--admin-object-id",
    bootstrapIdentity.principalId,
    "--admin-display-name",
    bootstrapIdentity.name,
    "--admin-type",
    "ServicePrincipal",
    "--subnet",
    subnetId,
    "--private-dns-zone",
    privateDnsZoneId,
    "--tags",
    "workload=openhands-halo",
    "environment=shared",
    "--yes",
    "--output",
    "none",
  ];
}

export function postgresServerAuthUpdateArgs() {
  return [
    "postgres",
    "flexible-server",
    "update",
    "--resource-group",
    config.postgres.resourceGroup,
    "--name",
    config.postgres.serverName,
    "--set",
    "authConfig.activeDirectoryAuth=Enabled",
    `authConfig.tenantId=${config.azure.tenantId}`,
    "--password-auth",
    "Enabled",
    "--output",
    "none",
  ];
}

export function validateBuildNodePool(nodePool) {
  const build = config.build;
  const expectedLabel = build.nodeTaintValue;
  const expectedTaint = `${build.nodeTaintKey}=${build.nodeTaintValue}:NoSchedule`;
  const mismatches = [];
  if (nodePool.mode !== "User") mismatches.push("mode=User");
  if (nodePool.osType !== "Linux") mismatches.push("osType=Linux");
  if (nodePool.osSku !== "Ubuntu") mismatches.push("osSku=Ubuntu");
  if (nodePool.vmSize !== build.nodePoolVmSize) {
    mismatches.push(`vmSize=${build.nodePoolVmSize}`);
  }
  if (nodePool.osDiskType !== build.nodePoolOsDiskType) {
    mismatches.push(`osDiskType=${build.nodePoolOsDiskType}`);
  }
  if (nodePool.osDiskSizeGb !== build.nodePoolOsDiskSizeGb) {
    mismatches.push(`osDiskSizeGb=${build.nodePoolOsDiskSizeGb}`);
  }
  if (!nodePool.enableAutoScaling) mismatches.push("autoscaling enabled");
  if (nodePool.minCount !== build.nodePoolMinCount) {
    mismatches.push(`minCount=${build.nodePoolMinCount}`);
  }
  if (nodePool.maxCount !== build.nodePoolMaxCount) {
    mismatches.push(`maxCount=${build.nodePoolMaxCount}`);
  }
  if (nodePool.securityProfile?.sshAccess !== "Disabled") {
    mismatches.push("SSH access disabled");
  }
  if (nodePool.nodeLabels?.[build.nodeTaintKey] !== expectedLabel) {
    mismatches.push(`label ${build.nodeTaintKey}=${build.nodeTaintValue}`);
  }
  if (!nodePool.nodeTaints?.includes(expectedTaint)) {
    mismatches.push(`taint ${expectedTaint}`);
  }
  if (nodePool.securityProfile?.sshAccess !== "Disabled") {
    mismatches.push("SSH access disabled");
  }
  if (mismatches.length > 0) {
    throw new Error(
      `AKS node pool ${build.nodePool} does not match the Halo build contract: ${mismatches.join(", ")}`,
    );
  }
}

export function validateWindowsRuntimeNodePool(nodePool) {
  const runtime = config.windowsRuntime;
  const expectedTaint = `${runtime.nodeTaintKey}=${runtime.nodeTaintValue}:NoSchedule`;
  const mismatches = [];
  if (nodePool.mode !== "User") mismatches.push("mode=User");
  if (nodePool.osType !== "Windows") mismatches.push("osType=Windows");
  if (nodePool.osSku !== runtime.osSku) {
    mismatches.push(`osSku=${runtime.osSku}`);
  }
  if (nodePool.vmSize !== runtime.nodePoolVmSize) {
    mismatches.push(`vmSize=${runtime.nodePoolVmSize}`);
  }
  if (nodePool.osDiskType !== runtime.nodePoolOsDiskType) {
    mismatches.push(`osDiskType=${runtime.nodePoolOsDiskType}`);
  }
  if (nodePool.osDiskSizeGb !== runtime.nodePoolOsDiskSizeGb) {
    mismatches.push(`osDiskSizeGb=${runtime.nodePoolOsDiskSizeGb}`);
  }
  if (!nodePool.enableAutoScaling) mismatches.push("autoscaling enabled");
  if (nodePool.minCount !== runtime.nodePoolMinCount) {
    mismatches.push(`minCount=${runtime.nodePoolMinCount}`);
  }
  if (nodePool.maxCount !== runtime.nodePoolMaxCount) {
    mismatches.push(`maxCount=${runtime.nodePoolMaxCount}`);
  }
  if (nodePool.nodeLabels?.[runtime.nodeTaintKey] !== runtime.nodeTaintValue) {
    mismatches.push(`label ${runtime.nodeTaintKey}=${runtime.nodeTaintValue}`);
  }
  if (
    nodePool.nodeLabels?.["openhands.dev/pagefile-gib"] !==
    String(runtime.pagefileSizeGiB)
  ) {
    mismatches.push(
      `label openhands.dev/pagefile-gib=${runtime.pagefileSizeGiB}`,
    );
  }
  if (!nodePool.nodeTaints?.includes(expectedTaint)) {
    mismatches.push(`taint ${expectedTaint}`);
  }
  if (nodePool.securityProfile?.sshAccess !== "Disabled") {
    mismatches.push("SSH access disabled");
  }
  if (mismatches.length > 0) {
    throw new Error(
      `AKS node pool ${runtime.nodePool} does not match the Halo Windows runtime contract: ${mismatches.join(", ")}`,
    );
  }
}

function ensureBuildNodePool() {
  const build = config.build;
  const existing = az(
    [
      "aks",
      "nodepool",
      "list",
      "--subscription",
      config.azure.subscriptionId,
      "--resource-group",
      config.azure.resourceGroup,
      "--cluster-name",
      config.azure.aksCluster,
      "--query",
      `[?name=='${build.nodePool}'] | [0]`,
      "--output",
      "json",
    ],
    { capture: true },
  );
  if (!existing || existing === "null") {
    az(buildNodePoolCreateArgs());
  }
  const nodePool = JSON.parse(
    az(
      [
        "aks",
        "nodepool",
        "show",
        "--subscription",
        config.azure.subscriptionId,
        "--resource-group",
        config.azure.resourceGroup,
        "--cluster-name",
        config.azure.aksCluster,
        "--name",
        build.nodePool,
        "--output",
        "json",
      ],
      { capture: true },
    ),
  );
  validateBuildNodePool(nodePool);
}

function ensureWindowsRuntimeNodePool() {
  const runtime = config.windowsRuntime;
  const existing = az(
    [
      "aks",
      "nodepool",
      "list",
      "--subscription",
      config.azure.subscriptionId,
      "--resource-group",
      config.azure.resourceGroup,
      "--cluster-name",
      config.azure.aksCluster,
      "--query",
      `[?name=='${runtime.nodePool}'] | [0]`,
      "--output",
      "json",
    ],
    { capture: true },
  );
  if (!existing || existing === "null") {
    az(windowsRuntimeNodePoolCreateArgs());
  } else {
    az(windowsRuntimeNodePoolAutoscalerArgs());
  }
  const nodePool = JSON.parse(
    az(
      [
        "aks",
        "nodepool",
        "show",
        "--subscription",
        config.azure.subscriptionId,
        "--resource-group",
        config.azure.resourceGroup,
        "--cluster-name",
        config.azure.aksCluster,
        "--name",
        runtime.nodePool,
        "--output",
        "json",
      ],
      { capture: true },
    ),
  );
  validateWindowsRuntimeNodePool(nodePool);
}

export function runtimeNodePoolAutoscalerArgs() {
  return [
    "aks",
    "nodepool",
    "update",
    "--subscription",
    config.azure.subscriptionId,
    "--resource-group",
    config.azure.resourceGroup,
    "--cluster-name",
    config.azure.aksCluster,
    "--name",
    config.runtime.nodePool,
    "--update-cluster-autoscaler",
    "--min-count",
    String(config.runtime.nodePoolMinCount),
    "--max-count",
    String(config.runtime.nodePoolMaxCount),
    "--output",
    "none",
  ];
}

function ensureRuntimeNodePool() {
  az(runtimeNodePoolAutoscalerArgs());
  const nodePool = JSON.parse(
    az(
      [
        "aks",
        "nodepool",
        "show",
        "--subscription",
        config.azure.subscriptionId,
        "--resource-group",
        config.azure.resourceGroup,
        "--cluster-name",
        config.azure.aksCluster,
        "--name",
        config.runtime.nodePool,
        "--output",
        "json",
      ],
      { capture: true },
    ),
  );
  const expectedTaint = `${config.runtime.nodeTaintKey}=${config.runtime.nodeTaintValue}:NoSchedule`;
  if (
    !nodePool.enableAutoScaling ||
    nodePool.minCount !== config.runtime.nodePoolMinCount ||
    nodePool.maxCount !== config.runtime.nodePoolMaxCount ||
    nodePool.nodeLabels?.[config.runtime.nodeTaintKey] !==
      config.runtime.nodeTaintValue ||
    !nodePool.nodeTaints?.includes(expectedTaint)
  ) {
    throw new Error(
      `AKS node pool ${config.runtime.nodePool} does not match the Halo runtime capacity and isolation contract`,
    );
  }
}

function graphPatch(applicationObjectId, body, suffix) {
  const path = join(
    tmpdir(),
    `openhands-halo-entra-${applicationObjectId}-${suffix}-${process.pid}.json`,
  );
  writeFileSync(path, JSON.stringify(body), "utf8");
  try {
    az([
      "rest",
      "--method",
      "PATCH",
      "--url",
      `https://graph.microsoft.com/v1.0/applications/${applicationObjectId}`,
      "--headers",
      "Content-Type=application/json",
      "--body",
      `@${path}`,
      "--output",
      "none",
    ]);
  } finally {
    unlinkSync(path);
  }
}

export function entraIdentifierUri(environment) {
  return `api://${config.environments[environment].entraClientId}`;
}

function ensureEntraApplication(environment) {
  const env = config.environments[environment];
  const application = JSON.parse(
    az(["ad", "app", "show", "--id", env.entraClientId, "--output", "json"], {
      capture: true,
    }),
  );
  if (application.displayName !== env.entraDisplayName) {
    throw new Error(
      `Expected Entra app ${env.entraDisplayName}, found ${application.displayName}`,
    );
  }
  const scope = {
    id: env.entraScopeId,
    adminConsentDescription: `Access ${env.entraDisplayName} as the signed-in user.`,
    adminConsentDisplayName: `Access ${env.entraDisplayName}`,
    isEnabled: true,
    type: "User",
    userConsentDescription: `Access ${env.entraDisplayName} as you.`,
    userConsentDisplayName: `Access ${env.entraDisplayName}`,
    value: "access_as_user",
  };
  const api = {
    requestedAccessTokenVersion: 2,
    oauth2PermissionScopes: [scope],
    preAuthorizedApplications: [],
  };
  graphPatch(
    application.id,
    {
      groupMembershipClaims: null,
      identifierUris: [entraIdentifierUri(environment)],
      api,
      web: {
        homePageUrl: `https://${env.frontDoorHost}`,
        logoutUrl: `https://${env.frontDoorHost}/`,
        redirectUris: [`https://${env.frontDoorHost}/auth/callback`],
        implicitGrantSettings: {
          enableAccessTokenIssuance: false,
          enableIdTokenIssuance: false,
        },
      },
    },
    "scope",
  );
  graphPatch(
    application.id,
    {
      api: {
        ...api,
        preAuthorizedApplications: [
          {
            appId: env.entraClientId,
            delegatedPermissionIds: [env.entraScopeId],
          },
        ],
      },
    },
    "preauthorization",
  );
}

export function renderBuildJob({
  commit,
  agentServerCommit,
  sandboxServerCommit,
}) {
  const short = commit.slice(0, 9);
  const agentServerShort = agentServerCommit.slice(0, 9);
  const sandboxShort = sandboxServerCommit.slice(0, 9);
  const build = config.build;
  const image = `${config.azure.acrLoginServer}/${build.repository}:${short}`;
  const cache = `${config.azure.acrLoginServer}/${build.repository}:${build.cacheTag}`;
  const agentServerImage = `${config.azure.acrLoginServer}/${build.agentServerRepository}:${agentServerShort}`;
  const agentServerCache = `${config.azure.acrLoginServer}/${build.agentServerRepository}:${build.agentServerCacheTag}`;
  const sandboxImage = `${config.azure.acrLoginServer}/${build.sandboxServerRepository}:${sandboxShort}`;
  const sandboxCache = `${config.azure.acrLoginServer}/${build.sandboxServerRepository}:${build.sandboxServerCacheTag}`;
  const sandboxRuntimeImage = `${config.azure.acrLoginServer}/${build.sandboxRuntimeRepository}:${sandboxShort}`;
  const sandboxRuntimeCache = `${config.azure.acrLoginServer}/${build.sandboxRuntimeRepository}:${build.sandboxRuntimeCacheTag}`;
  return `apiVersion: batch/v1
kind: Job
metadata:
  name: halo-build-${short}
  namespace: ${build.namespace}
  labels:
    app.kubernetes.io/name: openhands-halo-builder
    openhands.dev/git-sha: ${quote(short)}
spec:
  backoffLimit: 0
  activeDeadlineSeconds: 5400
  ttlSecondsAfterFinished: 600
  template:
    metadata:
      labels:
        app.kubernetes.io/name: openhands-halo-builder
        azure.workload.identity/use: "true"
    spec:
      restartPolicy: Never
      serviceAccountName: ${build.serviceAccount}
      nodeSelector:
        kubernetes.io/os: linux
        kubernetes.io/arch: amd64
        agentpool: ${build.nodePool}
      tolerations:
        - key: ${build.nodeTaintKey}
          operator: Equal
          value: ${build.nodeTaintValue}
          effect: NoSchedule
      initContainers:
        - name: source
          image: ${build.gitImage}
          command: ["/bin/sh", "-ec"]
          args:
            - |
              git clone --filter=blob:none --no-checkout ${config.source.repository} /workspace
              cd /workspace
              git checkout --detach ${commit}
              test "$(git rev-parse HEAD)" = "${commit}"
              chown -R 1000:1000 /workspace
          securityContext:
            runAsUser: 0
            runAsGroup: 0
          volumeMounts:
            - name: source
              mountPath: /workspace
        - name: sandbox-source
          image: ${build.gitImage}
          command: ["/bin/sh", "-ec"]
          args:
            - |
              git clone --filter=blob:none --no-checkout ${config.source.sandboxServerRepository} /sandbox-server
              cd /sandbox-server
              git checkout --detach ${sandboxServerCommit}
              test "$(git rev-parse HEAD)" = "${sandboxServerCommit}"
              chown -R 1000:1000 /sandbox-server
          securityContext:
            runAsUser: 0
            runAsGroup: 0
          volumeMounts:
            - name: sandbox-source
              mountPath: /sandbox-server
        - name: agent-server-source
          image: ${build.gitImage}
          command: ["/bin/sh", "-ec"]
          args:
            - |
              git clone --filter=blob:none --no-checkout ${config.source.agentServerSdkRepository} /agent-server
              cd /agent-server
              git checkout --detach ${agentServerCommit}
              test "$(git rev-parse HEAD)" = "${agentServerCommit}"
              chown -R 1000:1000 /agent-server
          securityContext:
            runAsUser: 0
            runAsGroup: 0
          volumeMounts:
            - name: agent-server-source
              mountPath: /agent-server
        - name: acr-auth
          image: ${build.azureCliImage}
          command: ["/bin/sh", "-ec"]
          args:
            - |
              token="$(cat "$AZURE_FEDERATED_TOKEN_FILE")"
              az login --service-principal --username "$AZURE_CLIENT_ID" --tenant "$AZURE_TENANT_ID" --federated-token "$token" --output none
              acr_token="$(az acr login --name ${config.azure.acrName} --expose-token --query accessToken -o tsv)"
              auth="$(printf '%s:%s' '00000000-0000-0000-0000-000000000000' "$acr_token" | base64 | tr -d '\\n')"
              mkdir -p /docker
              printf '{"auths":{"${config.azure.acrLoginServer}":{"auth":"%s"}}}\\n' "$auth" > /docker/config.json
              chown -R 1000:1000 /docker
              chmod 0700 /docker
              chmod 0600 /docker/config.json
          volumeMounts:
            - name: docker-config
              mountPath: /docker
      containers:
        - name: buildkit
          image: ${build.buildkitImage}
          command: ["/bin/sh", "-ec"]
          args:
            - |
              canvas_metadata=/tmp/canvas-build-metadata.json
              canvas_digest_file=/tmp/canvas-image-digest
              agent_server_metadata=/tmp/agent-server-build-metadata.json
              agent_server_digest_file=/tmp/agent-server-image-digest
              sandbox_metadata=/tmp/sandbox-build-metadata.json
              sandbox_digest_file=/tmp/sandbox-server-image-digest
              sandbox_runtime_metadata=/tmp/sandbox-runtime-build-metadata.json
              buildkitd \\
                --addr unix:///run/buildkit/buildkitd.sock &
              buildkitd_pid="$!"
              trap 'kill "$buildkitd_pid" 2>/dev/null || true' EXIT
              for attempt in $(seq 1 30); do
                if buildctl --addr unix:///run/buildkit/buildkitd.sock debug workers >/dev/null 2>&1; then
                  break
                fi
                if [ "$attempt" = 30 ]; then
                  echo "BuildKit daemon did not become ready" >&2
                  exit 1
                fi
                sleep 1
              done
              (
                buildctl --addr unix:///run/buildkit/buildkitd.sock build \\
                  --frontend dockerfile.v0 \\
                  --local context=/workspace \\
                  --local dockerfile=/workspace \\
                  --opt filename=docker/Dockerfile \\
                  --opt platform=linux/amd64 \\
                  --opt build-arg:AGENT_SERVER_IMAGE=${defaults.images.agentServer}:${defaults.versions.agentServer}-python \\
                  --opt build-arg:AGENT_SERVER_VERSION=${defaults.versions.agentServer} \\
                  --opt build-arg:AGENT_SERVER_SDK_GIT_REPOSITORY=${config.source.agentServerSdkRepository} \\
                  --opt build-arg:AGENT_SERVER_SDK_GIT_REF=${agentServerCommit} \\
                  --opt build-arg:AUTOMATION_VERSION=${defaults.versions.automation} \\
                  --opt build-arg:VITE_BASE_PATH=${defaults.paths.canvasBasePath} \\
                  --opt build-arg:VITE_HOSTED_PROFILE_SKILL_ALLOW_LIST=true \\
                  --opt build-arg:OPENHANDS_BUILD_GIT_SHA=${commit} \\
                  --opt build-arg:OPENHANDS_BUILD_GIT_REF=${config.source.branch} \\
                  --opt build-arg:AGENT_CANVAS_VERSION=halo-${short} \\
                  --import-cache type=registry,ref=${cache} \\
                  --export-cache type=registry,ref=${cache},mode=max,compression=zstd,ignore-error=true \\
                  --metadata-file "$canvas_metadata" \\
                  --output type=image,name=${image},push=true
                canvas_digest="$(sed -n 's/.*"containerimage.digest"[[:space:]]*:[[:space:]]*"\\(sha256:[a-f0-9]\\{64\\}\\)".*/\\1/p' "$canvas_metadata")"
                if ! printf '%s' "$canvas_digest" | grep -Eq '^sha256:[a-f0-9]{64}$'; then
                  echo "BuildKit did not report an immutable Canvas image digest" >&2
                  cat "$canvas_metadata" >&2
                  exit 1
                fi
                printf '%s\\n' "$canvas_digest" > "$canvas_digest_file"
              ) &
              canvas_build_pid="$!"
              (
                buildctl --addr unix:///run/buildkit/buildkitd.sock build \\
                  --frontend dockerfile.v0 \\
                  --local context=/agent-server \\
                  --local dockerfile=/agent-server \\
                  --opt filename=openhands-agent-server/openhands/agent_server/docker/Dockerfile \\
                  --opt target=binary \\
                  --opt platform=linux/amd64 \\
                  --import-cache type=registry,ref=${agentServerCache} \\
                  --export-cache type=registry,ref=${agentServerCache},mode=max,compression=zstd,ignore-error=true \\
                  --metadata-file "$agent_server_metadata" \\
                  --output type=image,name=${agentServerImage},push=true
                agent_server_digest="$(sed -n 's/.*"containerimage.digest"[[:space:]]*:[[:space:]]*"\\(sha256:[a-f0-9]\\{64\\}\\)".*/\\1/p' "$agent_server_metadata")"
                if ! printf '%s' "$agent_server_digest" | grep -Eq '^sha256:[a-f0-9]{64}$'; then
                  echo "BuildKit did not report an immutable Agent Server image digest" >&2
                  cat "$agent_server_metadata" >&2
                  exit 1
                fi
                printf '%s\\n' "$agent_server_digest" > "$agent_server_digest_file"
              ) &
              agent_server_build_pid="$!"
              (
                buildctl --addr unix:///run/buildkit/buildkitd.sock build \\
                  --frontend dockerfile.v0 \\
                  --local context=/sandbox-server \\
                  --local dockerfile=/sandbox-server \\
                  --opt filename=containers/app/Dockerfile \\
                  --opt target=openhands-sandbox-server \\
                  --opt platform=linux/amd64 \\
                  --opt build-arg:OPENHANDS_BUILD_VERSION=halo-${sandboxShort} \\
                  --opt build-arg:SOFTWARE_AGENT_SDK_REPOSITORY=${config.source.agentServerSdkRepository} \\
                  --opt build-arg:SOFTWARE_AGENT_SDK_REF=${agentServerCommit} \\
                  --import-cache type=registry,ref=${sandboxCache} \\
                  --export-cache type=registry,ref=${sandboxCache},mode=max,compression=zstd,ignore-error=true \\
                  --metadata-file "$sandbox_metadata" \\
                  --output type=image,name=${sandboxImage},push=true
                sandbox_digest="$(sed -n 's/.*"containerimage.digest"[[:space:]]*:[[:space:]]*"\\(sha256:[a-f0-9]\\{64\\}\\)".*/\\1/p' "$sandbox_metadata")"
                if ! printf '%s' "$sandbox_digest" | grep -Eq '^sha256:[a-f0-9]{64}$'; then
                  echo "BuildKit did not report an immutable Sandbox Server image digest" >&2
                  cat "$sandbox_metadata" >&2
                  exit 1
                fi
                printf '%s\\n' "$sandbox_digest" > "$sandbox_digest_file"
              ) &
              sandbox_server_build_pid="$!"
              wait "$agent_server_build_pid"
              agent_server_digest="$(cat "$agent_server_digest_file")"
              buildctl --addr unix:///run/buildkit/buildkitd.sock build \\
                --frontend dockerfile.v0 \\
                --local context=/sandbox-server \\
                --local dockerfile=/sandbox-server \\
                --opt filename=containers/sandbox/Dockerfile \\
                --opt platform=linux/amd64 \\
                --opt build-arg:AGENT_SERVER_IMAGE=${config.azure.acrLoginServer}/${build.agentServerRepository}@$agent_server_digest \\
                --import-cache type=registry,ref=${sandboxRuntimeCache} \\
                --export-cache type=registry,ref=${sandboxRuntimeCache},mode=max,compression=zstd,ignore-error=true \\
                --metadata-file "$sandbox_runtime_metadata" \\
                --output type=image,name=${sandboxRuntimeImage},push=true
              sandbox_runtime_digest="$(sed -n 's/.*"containerimage.digest"[[:space:]]*:[[:space:]]*"\\(sha256:[a-f0-9]\\{64\\}\\)".*/\\1/p' "$sandbox_runtime_metadata")"
              if ! printf '%s' "$sandbox_runtime_digest" | grep -Eq '^sha256:[a-f0-9]{64}$'; then
                echo "BuildKit did not report an immutable Sandbox Runtime image digest" >&2
                cat "$sandbox_runtime_metadata" >&2
                exit 1
              fi
              wait "$canvas_build_pid"
              wait "$sandbox_server_build_pid"
              canvas_digest="$(cat "$canvas_digest_file")"
              sandbox_digest="$(cat "$sandbox_digest_file")"
              printf '{"canvas":"%s","agentServer":"%s","sandboxServer":"%s","sandboxRuntime":"%s"}' "$canvas_digest" "$agent_server_digest" "$sandbox_digest" "$sandbox_runtime_digest" > /dev/termination-log
              printf 'CANVAS_IMAGE_DIGEST=%s\\n' "$canvas_digest"
              printf 'AGENT_SERVER_IMAGE_DIGEST=%s\\n' "$agent_server_digest"
              printf 'SANDBOX_SERVER_IMAGE_DIGEST=%s\\n' "$sandbox_digest"
              printf 'SANDBOX_RUNTIME_IMAGE_DIGEST=%s\\n' "$sandbox_runtime_digest"
          env:
            - name: DOCKER_CONFIG
              value: /docker
          securityContext:
            privileged: true
          resources:
            requests:
              cpu: "14"
              memory: 16Gi
              ephemeral-storage: 80Gi
            limits:
              cpu: "15"
              memory: 48Gi
              ephemeral-storage: 200Gi
          volumeMounts:
            - name: source
              mountPath: /workspace
              readOnly: true
            - name: sandbox-source
              mountPath: /sandbox-server
              readOnly: true
            - name: agent-server-source
              mountPath: /agent-server
              readOnly: true
            - name: docker-config
              mountPath: /docker
              readOnly: true
            - name: buildkit-state
              mountPath: /var/lib/buildkit
      volumes:
        - name: source
          emptyDir:
            sizeLimit: 8Gi
        - name: sandbox-source
          emptyDir:
            sizeLimit: 8Gi
        - name: agent-server-source
          emptyDir:
            sizeLimit: 8Gi
        - name: docker-config
          emptyDir: {}
        - name: buildkit-state
          emptyDir:
            sizeLimit: 200Gi
`;
}

export function buildDigestsFromPodList(podList) {
  for (const pod of podList?.items ?? []) {
    const status = (pod.status?.containerStatuses ?? []).find(
      (container) => container.name === "buildkit",
    );
    const message = status?.state?.terminated?.message?.trim();
    try {
      const digests = JSON.parse(message ?? "");
      return {
        canvas: normalizeDigest(digests.canvas),
        agentServer: normalizeDigest(digests.agentServer),
        sandboxServer: normalizeDigest(digests.sandboxServer),
        sandboxRuntime: normalizeDigest(digests.sandboxRuntime),
      };
    } catch {
      // Check other pods before reporting the missing build result.
    }
  }
  throw new Error("Build Job did not publish immutable image digests");
}

export function validateHindsightPostgresConfig() {
  const major = Number.parseInt(String(config.postgres.version), 10);
  if (!Number.isInteger(major) || major < 15) {
    throw new Error(
      `Hindsight requires PostgreSQL 15 or newer; Halo config has ${config.postgres.version}`,
    );
  }
  const [address, prefix] = String(config.hindsight.postgresCidr ?? "").split(
    "/",
  );
  if (
    isIP(address) !== 4 ||
    !/^(?:[0-9]|[12][0-9]|3[0-2])$/.test(prefix ?? "")
  ) {
    throw new Error(
      `Hindsight PostgreSQL network CIDR is invalid: ${config.hindsight.postgresCidr}`,
    );
  }
}

export function postgresExtensionsParameterValue(currentValue) {
  const extensions = String(currentValue ?? "")
    .split(",")
    .map((extension) => extension.trim().toUpperCase())
    .filter(Boolean);
  for (const requiredExtension of ["VECTOR", "PG_TRGM"]) {
    if (!extensions.includes(requiredExtension)) {
      extensions.push(requiredExtension);
    }
  }
  return extensions.join(",");
}

export function renderArcControllerValues() {
  const ci = config.ci;
  return `fullnameOverride: ${ci.controllerRelease}
serviceAccount:
  create: true
  name: ${ci.controllerRelease}
nodeSelector:
  kubernetes.io/os: linux
  kubernetes.io/arch: amd64
  agentpool: ${config.runtime.nodePool}
tolerations:
  - key: ${config.runtime.nodeTaintKey}
    operator: Equal
    value: ${config.runtime.nodeTaintValue}
    effect: NoSchedule
securityContext:
  allowPrivilegeEscalation: false
  runAsNonRoot: true
resources:
  requests:
    cpu: 100m
    memory: 128Mi
  limits:
    cpu: 500m
    memory: 512Mi
flags:
  logLevel: info
  logFormat: json
`;
}

export function renderArcRunnerValues() {
  const ci = config.ci;
  return `githubConfigUrl: ${quote(ci.githubConfigUrl)}
githubConfigSecret: ${ci.githubAppSecret}
runnerScaleSetName: ${ci.runnerScaleSetName}
minRunners: 0
maxRunners: ${ci.maxRunners}
controllerServiceAccount:
  namespace: ${ci.controllerNamespace}
  name: ${ci.controllerRelease}
listenerTemplate:
  spec:
    nodeSelector:
      kubernetes.io/os: linux
      kubernetes.io/arch: amd64
      agentpool: ${config.runtime.nodePool}
    tolerations:
      - key: ${config.runtime.nodeTaintKey}
        operator: Equal
        value: ${config.runtime.nodeTaintValue}
        effect: NoSchedule
    containers:
      - name: listener
        resources:
          requests:
            cpu: 50m
            memory: 64Mi
          limits:
            cpu: 250m
            memory: 256Mi
template:
  spec:
    serviceAccountName: ${ci.runnerServiceAccount}
    automountServiceAccountToken: true
    nodeSelector:
      kubernetes.io/os: linux
      kubernetes.io/arch: amd64
      agentpool: ${config.build.nodePool}
    tolerations:
      - key: ${config.build.nodeTaintKey}
        operator: Equal
        value: ${config.build.nodeTaintValue}
        effect: NoSchedule
    containers:
      - name: runner
        image: ${ci.runnerImage}
        command: ["/home/runner/run.sh"]
        securityContext:
          allowPrivilegeEscalation: false
          runAsNonRoot: true
          runAsUser: 1001
          runAsGroup: 1001
        resources:
          requests:
            cpu: 250m
            memory: 512Mi
            ephemeral-storage: 2Gi
          limits:
            cpu: "1"
            memory: 2Gi
            ephemeral-storage: 8Gi
`;
}

export function renderArcRunnerRbac() {
  const ci = config.ci;
  const subject = `subjects:
    - kind: ServiceAccount
      name: ${ci.runnerServiceAccount}
      namespace: ${ci.runnerNamespace}`;
  const adminBinding = (environment) => {
    const namespace = config.environments[environment].namespace;
    return `apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: ${ci.runnerServiceAccount}-admin
  namespace: ${namespace}
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: admin
${subject}
`;
  };
  const agentSandboxBinding = (environment) => {
    const namespace = config.environments[environment].namespace;
    return `apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: ${ci.runnerServiceAccount}-agent-sandbox
  namespace: ${namespace}
rules:
  - apiGroups: ["extensions.agents.x-k8s.io"]
    resources: ["sandboxtemplates", "sandboxwarmpools", "sandboxclaims"]
    verbs: ["create", "delete", "get", "list", "patch", "update", "watch"]
  - apiGroups: ["agents.x-k8s.io"]
    resources: ["sandboxes"]
    verbs: ["get", "list", "watch", "patch"]
  - apiGroups: [""]
    resources: ["pods", "persistentvolumeclaims", "events"]
    verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: ${ci.runnerServiceAccount}-agent-sandbox
  namespace: ${namespace}
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: ${ci.runnerServiceAccount}-agent-sandbox
${subject}
`;
  };
  return `apiVersion: v1
kind: Namespace
metadata:
  name: ${ci.controllerNamespace}
---
apiVersion: v1
kind: Namespace
metadata:
  name: ${ci.runnerNamespace}
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: ${ci.runnerServiceAccount}
  namespace: ${ci.runnerNamespace}
automountServiceAccountToken: true
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: ${ci.runnerServiceAccount}
  namespace: ${config.build.namespace}
rules:
  - apiGroups: ["batch"]
    resources: ["jobs"]
    verbs: ["create", "delete", "get", "list", "patch", "watch"]
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["get", "list", "watch"]
  - apiGroups: [""]
    resources: ["pods/log"]
    verbs: ["get"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: ${ci.runnerServiceAccount}
  namespace: ${config.build.namespace}
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: ${ci.runnerServiceAccount}
${subject}
---
${adminBinding("candidate")}---
${agentSandboxBinding("candidate")}---
${adminBinding("primary")}---
${agentSandboxBinding("primary")}`;
}

function bootstrapBuild() {
  ensureBuildNodePool();
  az(acrTrustedServicesUpdateArgs());
  const builder = identity(config.identities.builder);
  const windowsRuntimeImporter = ensureIdentity(
    config.identities.windowsRuntimeImporter,
  );
  const acrId = az(
    [
      "acr",
      "show",
      "--resource-group",
      config.azure.resourceGroup,
      "--name",
      config.azure.acrName,
      "--query",
      "id",
      "--output",
      "tsv",
    ],
    { capture: true },
  );
  ensureRole({
    principalId: builder.principalId,
    role: "AcrPush",
    scope: acrId,
  });
  ensureRole({
    principalId: windowsRuntimeImporter.principalId,
    role: "Container Registry Data Importer and Data Reader",
    scope: acrId,
  });
  ensureFederatedCredential({
    identityName: config.identities.builder,
    credentialName: config.build.federatedCredential,
    namespace: config.build.namespace,
    serviceAccount: config.build.serviceAccount,
  });
  ensureNamespaceAndServiceAccount(
    config.build.namespace,
    config.build.serviceAccount,
    builder.clientId,
  );
  ensureFederatedCredential({
    identityName: config.identities.windowsRuntimeImporter,
    credentialName: config.build.windowsRuntimeImporterFederatedCredential,
    namespace: config.build.namespace,
    serviceAccount: config.build.windowsRuntimeImporterServiceAccount,
  });
  ensureNamespaceAndServiceAccount(
    config.build.namespace,
    config.build.windowsRuntimeImporterServiceAccount,
    windowsRuntimeImporter.clientId,
  );
  return builder;
}

export function renderSecretProviderClass(environment, runtimeClientId) {
  const env = config.environments[environment];
  const entries = [
    ["clientSecret", env.secrets.clientSecret],
    ["cookieSecret", env.secrets.cookieSecret],
    ["sessionApiKey", env.secrets.sessionApiKey],
    ["ohSecretKey", env.secrets.ohSecretKey],
    ["automationKvSecret", env.secrets.automationKvSecret],
    ["trustedIdentityAssertion", env.secrets.trustedIdentityAssertion],
    ["jwtSecret", env.secrets.jwtSecret],
    ["githubAppClientId", env.githubApp.secrets.clientId],
    ["githubAppClientSecret", env.githubApp.secrets.clientSecret],
  ].filter(([, name]) => Boolean(name));
  return `apiVersion: secrets-store.csi.x-k8s.io/v1
kind: SecretProviderClass
metadata:
  name: openhands-halo-secrets
  namespace: ${env.namespace}
spec:
  provider: azure
  secretObjects:
    - secretName: openhands-halo-secrets
      type: Opaque
      data:
${entries.map(([alias]) => `        - objectName: ${alias}\n          key: ${alias}`).join("\n")}
    - secretName: openhands-agent-server-bootstrap
      type: Opaque
      data:
        - objectName: ohSecretKey
          key: secret-key
  parameters:
    usePodIdentity: "false"
    clientID: ${quote(runtimeClientId)}
    keyvaultName: ${quote(config.azure.keyVaultName)}
    tenantId: ${quote(config.azure.tenantId)}
    objects: |
      array:
${entries.map(([alias, name]) => `        - |\n          objectName: ${name}\n          objectAlias: ${alias}\n          objectType: secret`).join("\n")}
`;
}

export function renderHindsightSecretProviderClass(
  environment,
  runtimeClientId,
) {
  const env = config.environments[environment];
  if (!env.hindsight?.enabled) return "";
  const entries = [
    ["hindsightDatabasePassword", env.hindsight.secrets.databasePassword],
    ["hindsightApiKey", env.hindsight.secrets.apiKey],
    ["hindsightLlmApiKey", env.hindsight.secrets.llmApiKey],
  ];
  return `apiVersion: secrets-store.csi.x-k8s.io/v1
kind: SecretProviderClass
metadata:
  name: openhands-hindsight-secrets
  namespace: ${env.namespace}
spec:
  provider: azure
  parameters:
    usePodIdentity: "false"
    clientID: ${quote(runtimeClientId)}
    keyvaultName: ${quote(config.azure.keyVaultName)}
    tenantId: ${quote(config.azure.tenantId)}
    objects: |
      array:
${entries.map(([alias, name]) => `        - |\n          objectName: ${name}\n          objectAlias: ${alias}\n          objectType: secret`).join("\n")}
`;
}

export function renderHindsightBrokerSecretProviderClass(
  environment,
  runtimeClientId,
) {
  const env = config.environments[environment];
  if (!env.hindsight?.enabled) return "";
  const entries = [
    ["hindsightApiKey", env.hindsight.secrets.apiKey],
    ["hindsightBankSecret", env.hindsight.secrets.bankSecret],
    ["hindsightScopeBindingsJson", env.hindsight.secrets.scopeBindingsJson],
  ];
  return `apiVersion: secrets-store.csi.x-k8s.io/v1
kind: SecretProviderClass
metadata:
  name: openhands-hindsight-broker-secrets
  namespace: ${env.namespace}
spec:
  provider: azure
  parameters:
    usePodIdentity: "false"
    clientID: ${quote(runtimeClientId)}
    keyvaultName: ${quote(config.azure.keyVaultName)}
    tenantId: ${quote(config.azure.tenantId)}
    objects: |
      array:
${entries.map(([alias, name]) => `        - |\n          objectName: ${name}\n          objectAlias: ${alias}\n          objectType: secret`).join("\n")}
`;
}

export function renderRbacBootstrapSecretProviderClass(
  environment,
  runtimeClientId,
) {
  const env = config.environments[environment];
  const bootstrapJson = env.rbac?.secrets?.bootstrapJson;
  if (!bootstrapJson) return "";
  return `apiVersion: secrets-store.csi.x-k8s.io/v1
kind: SecretProviderClass
metadata:
  name: openhands-rbac-bootstrap-secrets
  namespace: ${env.namespace}
spec:
  provider: azure
  parameters:
    usePodIdentity: "false"
    clientID: ${quote(runtimeClientId)}
    keyvaultName: ${quote(config.azure.keyVaultName)}
    tenantId: ${quote(config.azure.tenantId)}
    objects: |
      array:
        - |
          objectName: ${bootstrapJson}
          objectAlias: rbacBootstrapJson
          objectType: secret
`;
}

export function renderPostgresBootstrapSecretProviderClass(bootstrapClientId) {
  const entries = Object.entries(config.environments)
    .filter(([, env]) => env.hindsight?.enabled)
    .map(([environment, env]) => [
      `${environment}HindsightDatabasePassword`,
      env.hindsight.secrets.databasePassword,
    ]);
  return `apiVersion: secrets-store.csi.x-k8s.io/v1
kind: SecretProviderClass
metadata:
  name: openhands-halo-postgres-bootstrap-secrets
  namespace: ${config.build.namespace}
spec:
  provider: azure
  parameters:
    usePodIdentity: "false"
    clientID: ${quote(bootstrapClientId)}
    keyvaultName: ${quote(config.azure.keyVaultName)}
    tenantId: ${quote(config.azure.tenantId)}
    objects: |
      array:
${entries.map(([alias, name]) => `        - |\n          objectName: ${name}\n          objectAlias: ${alias}\n          objectType: secret`).join("\n")}
`;
}

function hindsightBrokerEnv(environment) {
  const env = config.environments[environment];
  const hindsight = env.hindsight;
  if (!hindsight?.enabled) {
    return `            - name: OH_HINDSIGHT_ENABLED
              value: "false"
`;
  }
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(hindsight.deploymentId)) {
    throw new Error(
      `${environment} Hindsight deploymentId must be a stable lowercase identifier`,
    );
  }
  return `            - name: OH_HINDSIGHT_ENABLED
              value: "true"
            - name: OH_HINDSIGHT_FAIL_OPEN
              value: ${quote(String(hindsight.failOpen))}
            - name: OH_HINDSIGHT_LINUX_ONLY
              value: ${quote(String(hindsight.linuxOnly))}
            - name: OH_HINDSIGHT_BASE_URL
              value: http://${config.hindsight.serviceName}:${config.hindsight.port}
            - name: OH_HINDSIGHT_BROKER_URL
              value: http://${config.sandboxServer.serviceName}:${config.sandboxServer.port}
            - name: OH_HINDSIGHT_DEPLOYMENT_ID
              value: ${quote(hindsight.deploymentId)}
            - name: OH_HINDSIGHT_API_KEY_FILE
              value: /mnt/hindsight-secrets/hindsightApiKey
            - name: OH_HINDSIGHT_BANK_SECRET_FILE
              value: /mnt/hindsight-secrets/hindsightBankSecret
            - name: OH_HINDSIGHT_SCOPE_BINDINGS_JSON_FILE
              value: /mnt/hindsight-secrets/hindsightScopeBindingsJson
            - name: OH_HINDSIGHT_AUTOMATIC_RECALL_DEFAULT_MAX_TOKENS
              value: "${config.hindsight.recall.defaultTokenCeiling}"
            - name: OH_HINDSIGHT_AUTOMATIC_RECALL_ADAPTIVE_MAX_TOKENS
              value: "${config.hindsight.recall.adaptiveTokenCeiling}"
            - name: OH_HINDSIGHT_DEEP_RECALL_MAX_TOKENS
              value: "${config.hindsight.recall.deepTokenCeiling}"
`;
}

export function renderHindsightResources(environment) {
  const env = config.environments[environment];
  const hindsight = env.hindsight;
  if (!hindsight?.enabled) return "";
  validateHindsightPostgresConfig();
  const image = externalImageReference(
    config.hindsight.image.repository,
    config.hindsight.image.digest,
  );
  return `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${config.hindsight.serviceName}
  namespace: ${env.namespace}
  labels:
    app.kubernetes.io/name: ${config.hindsight.serviceName}
spec:
  replicas: 1
  strategy:
    type: Recreate
  selector:
    matchLabels:
      app.kubernetes.io/name: ${config.hindsight.serviceName}
  template:
    metadata:
      labels:
        app.kubernetes.io/name: ${config.hindsight.serviceName}
        azure.workload.identity/use: "true"
      annotations:
        openhands.dev/hindsight-license-reviewed-revision: ${quote(config.hindsight.source.revision)}
        openhands.dev/hindsight-license: ${quote(config.hindsight.source.license)}
    spec:
      serviceAccountName: ${env.serviceAccount}
      automountServiceAccountToken: false
      terminationGracePeriodSeconds: 75
      nodeSelector:
        kubernetes.io/os: linux
        kubernetes.io/arch: amd64
        agentpool: ${config.runtime.nodePool}
      tolerations:
        - key: ${config.runtime.nodeTaintKey}
          operator: Equal
          value: ${config.runtime.nodeTaintValue}
          effect: NoSchedule
      containers:
        - name: hindsight
          image: ${image}
          imagePullPolicy: IfNotPresent
          command: ["/bin/sh", "-ec"]
          args:
            - |
              export HINDSIGHT_DATABASE_PASSWORD="$(cat /mnt/hindsight-secrets/hindsightDatabasePassword)"
              encoded_password="$(python -c 'import os, urllib.parse; print(urllib.parse.quote(os.environ["HINDSIGHT_DATABASE_PASSWORD"], safe=""))')"
              export HINDSIGHT_API_DATABASE_URL="postgresql://${hindsight.databaseUser}:$encoded_password@${config.postgres.fqdn}:5432/${hindsight.database}?sslmode=require"
              export HINDSIGHT_API_TENANT_API_KEY="$(cat /mnt/hindsight-secrets/hindsightApiKey)"
              export HINDSIGHT_API_LLM_API_KEY="$(cat /mnt/hindsight-secrets/hindsightLlmApiKey)"
              exec /app/start-all.sh
          ports:
            - name: http
              containerPort: ${config.hindsight.port}
          env:
            - name: PGSSLMODE
              value: require
            - name: HINDSIGHT_API_DATABASE_SCHEMA
              value: ${config.hindsight.databaseSchema}
            - name: HINDSIGHT_API_RUN_MIGRATIONS_ON_STARTUP
              value: "true"
            - name: HINDSIGHT_API_VECTOR_EXTENSION
              value: pgvector
            - name: HINDSIGHT_API_TENANT_EXTENSION
              value: ${config.hindsight.tenantExtension}
            - name: HINDSIGHT_API_LLM_PROVIDER
              value: ${config.hindsight.llmProvider}
            - name: HINDSIGHT_API_LLM_BASE_URL
              value: ${config.hindsight.llmBaseUrl}
            - name: HINDSIGHT_API_LLM_MODEL
              value: ${config.hindsight.llmModel}
            - name: HINDSIGHT_API_WORKER_ID
              value: halo-${environment}
          startupProbe:
            httpGet:
              path: /health
              port: http
            periodSeconds: 10
            failureThreshold: 60
          readinessProbe:
            httpGet:
              path: /health
              port: http
            initialDelaySeconds: 10
            periodSeconds: 5
            timeoutSeconds: 3
            failureThreshold: 3
          livenessProbe:
            httpGet:
              path: /health/live
              port: http
            initialDelaySeconds: 30
            periodSeconds: 10
            timeoutSeconds: 5
            failureThreshold: 3
          resources:
            requests:
              cpu: ${config.hindsight.resources.cpuRequest}
              memory: ${config.hindsight.resources.memoryRequest}
            limits:
              cpu: ${quote(config.hindsight.resources.cpuLimit)}
              memory: ${config.hindsight.resources.memoryLimit}
          volumeMounts:
            - name: hindsight-secrets-store
              mountPath: /mnt/hindsight-secrets
              readOnly: true
      volumes:
        - name: hindsight-secrets-store
          csi:
            driver: secrets-store.csi.k8s.io
            readOnly: true
            volumeAttributes:
              secretProviderClass: openhands-hindsight-secrets
---
apiVersion: v1
kind: Service
metadata:
  name: ${config.hindsight.serviceName}
  namespace: ${env.namespace}
spec:
  type: ClusterIP
  selector:
    app.kubernetes.io/name: ${config.hindsight.serviceName}
  ports:
    - name: http
      port: ${config.hindsight.port}
      targetPort: http
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: ${config.hindsight.serviceName}
  namespace: ${env.namespace}
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: ${config.hindsight.serviceName}
  policyTypes:
    - Ingress
    - Egress
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app.kubernetes.io/name: ${config.sandboxServer.serviceName}
      ports:
        - protocol: TCP
          port: ${config.hindsight.port}
  egress:
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
      ports:
        - protocol: UDP
          port: 53
        - protocol: TCP
          port: 53
    - to:
        - ipBlock:
            cidr: ${config.hindsight.postgresCidr}
      ports:
        - protocol: TCP
          port: 5432
    - ports:
        - protocol: TCP
          port: 443
`;
}

export function renderHelmValues(environment, digest, runtimeClientId) {
  const env = config.environments[environment];
  normalizeDigest(digest);
  const image = imageReference(
    config.azure.acrLoginServer,
    config.build.repository,
    digest,
  );
  return `fullnameOverride: openhands-halo
podDisruptionBudget:
  enabled: true
  minAvailable: 1
image:
  repository: ${config.azure.acrLoginServer}/${config.build.repository}
  digest: ${digest}
  pullPolicy: IfNotPresent
serviceAccount:
  create: false
  name: ${env.serviceAccount}
  automountServiceAccountToken: true
  annotations:
    azure.workload.identity/client-id: ${quote(runtimeClientId)}
podLabels:
  azure.workload.identity/use: "true"
nodeSelector:
  kubernetes.io/os: linux
  kubernetes.io/arch: amd64
  agentpool: ${config.runtime.nodePool}
tolerations:
  - key: ${config.runtime.nodeTaintKey}
    operator: Equal
    value: ${config.runtime.nodeTaintValue}
    effect: NoSchedule
rbac:
  enabled: false
ingress:
  enabled: true
  className: azure-application-gateway
  annotations:
    appgw.ingress.kubernetes.io/backend-protocol: "http"
    appgw.ingress.kubernetes.io/health-probe-path: "/ready"
  hosts:
    - host: ${env.frontDoorHost}
      paths:
        - path: /
          pathType: Prefix
  tls: []
entra:
  enabled: true
  tenantId: ${config.azure.tenantId}
  clientId: ${env.entraClientId}
  redirectUri: https://${env.frontDoorHost}/auth/callback
  scopes: "openid profile email api://${env.entraClientId}/access_as_user"
  clientSecret:
    existingSecret: openhands-halo-secrets
    key: clientSecret
  cookieSecret:
    existingSecret: openhands-halo-secrets
    key: cookieSecret
secrets:
  sessionApiKey:
    existingSecret: openhands-halo-secrets
    key: sessionApiKey
  ohSecretKey:
    existingSecret: openhands-halo-secrets
    key: ohSecretKey
config:
  extraEnv:
    - name: OH_CONVERSATIONS_PATH
      value: /home/openhands/conversations
    - name: DO_NOT_TRACK
      value: "1"
    - name: VITE_DO_NOT_TRACK
      value: "1"
    - name: AGENT_CANVAS_DISABLE_TELEMETRY
      value: "1"
    - name: OH_TRUSTED_IDENTITY_ASSERTION_SECRET
      valueFrom:
        secretKeyRef:
          name: openhands-halo-secrets
          key: trustedIdentityAssertion
    - name: OH_TRUSTED_IDENTITY_ASSERTION_ISSUER
      value: ${config.sandboxServer.trustedIdentityIssuer}
    - name: OH_TRUSTED_IDENTITY_ASSERTION_AUDIENCE
      value: ${config.sandboxServer.trustedIdentityAudience}
    - name: SANDBOX_SERVER_URL
      value: http://${config.sandboxServer.serviceName}:${config.sandboxServer.port}
    - name: AGENT_CANVAS_CLOUD_URL
      value: https://${env.frontDoorHost}
    - name: OH_WEB_URL
      value: https://${env.frontDoorHost}
    - name: AGENT_CANVAS_CLOUD_ORGANIZATION_MODE
      value: required
    - name: AGENT_CANVAS_CLOUD_MCP_API_MODE
      value: agent-server
    - name: AGENT_CANVAS_EXTERNAL_SETTINGS_SHELL
      value: "false"
    - name: AGENT_CANVAS_SANDBOX_RUNTIME_NAMESPACE
      value: ${env.namespace}
    - name: AGENT_CANVAS_SANDBOX_RUNTIME_NAME_PREFIX
      value: ${config.sandboxServer.claimNamePrefix}
    - name: LLM_MODEL
      value: azure/${config.azureOpenAI.deployment}
    - name: LLM_BASE_URL
      value: ${config.azureOpenAI.endpoint}
    - name: LLM_API_VERSION
      value: ${config.azureOpenAI.apiVersion}
    - name: LLM_AUTH_TYPE
      value: azure_workload_identity
    - name: AUTOMATION_KV_SECRET
      valueFrom:
        secretKeyRef:
          name: openhands-halo-secrets
          key: automationKvSecret
extraInitContainers:
  - name: migrate-conversations
    image: ${image}
    imagePullPolicy: IfNotPresent
    command: ["/bin/sh", "-ec"]
    args:
      - |
        if [ -z "$(find /conversations -mindepth 1 -maxdepth 1 -print -quit)" ] && [ -d /legacy/agent-canvas/conversations ]; then
          cp -R /legacy/agent-canvas/conversations/. /conversations/
        fi
    securityContext:
      runAsUser: 10001
      runAsGroup: 10001
    volumeMounts:
      - name: data
        mountPath: /legacy
        subPath: openhands
        readOnly: true
      - name: halo-conversations
        mountPath: /conversations
extraVolumes:
  - name: halo-conversations
    persistentVolumeClaim:
      claimName: ${env.conversationPvc}
  - name: halo-secrets-store
    csi:
      driver: secrets-store.csi.k8s.io
      readOnly: true
      volumeAttributes:
        secretProviderClass: openhands-halo-secrets
extraVolumeMounts:
  - name: halo-conversations
    mountPath: /home/openhands/conversations
  - name: halo-secrets-store
    mountPath: /mnt/secrets-store
    readOnly: true
`;
}

function sandboxSpecBootstrapProfiles(
  environment,
  sandboxRuntimeDigest,
  windowsRuntimeDigest,
) {
  const linuxImage = imageReference(
    config.azure.acrLoginServer,
    config.build.sandboxRuntimeRepository,
    sandboxRuntimeDigest,
  );
  const windowsImage = externalImageReference(
    config.windowsRuntime.imageRepository,
    windowsRuntimeDigest,
  );
  return config.agentSandbox.profileSeeds.map((profile) => {
    const isWindows = profile.os === "windows";
    const bootstrapProfile = {
      id: profile.id,
      display_name: profile.name,
      description: null,
      enabled: profile.enabled,
      published: true,
      availability: "available",
      availability_reason: null,
      operating_system: profile.os,
      platform: isWindows ? config.windowsRuntime.platform : "linux/amd64",
      resource_class: profile.resourceClass,
      image: isWindows ? windowsImage : linuxImage,
      shell: isWindows ? ["powershell.exe", "-NoLogo", "-NoProfile"] : ["bash"],
      workspace_mount_path: isWindows
        ? config.windowsRuntime.workspacePath
        : "/workspace",
      durable_state_dir: isWindows
        ? "C:\\workspace\\.openhands"
        : "/workspace/.openhands",
      durable_mount_path: isWindows
        ? config.windowsRuntime.workspacePath
        : "/workspace",
      template_name: profile.template,
      warm_pool_name: profile.warmPool,
      warm_pool_replicas: profile.warmPoolReplicas,
      cpu_request: profile.cpuRequest,
      cpu_limit: profile.cpuLimit,
      cpu_cores: Number(profile.cpuLimit),
      memory_request: profile.memoryRequest,
      memory_limit: profile.memoryLimit,
      memory_gib: Number(profile.memoryLimit.replace(/Gi$/, "")),
      workspace_storage_class: profile.storageClass,
      workspace_storage_size: profile.storageSize,
      storage_class: profile.storageClass,
      storage_size: profile.storageSize,
      durable_storage_class: null,
      durable_storage_size: null,
      durable_volume_claim_name: null,
      durable_sub_path_template: null,
      node_selector: {
        "kubernetes.io/os": profile.os,
        "kubernetes.io/arch": "amd64",
        agentpool: profile.nodePool,
        ...(isWindows
          ? {
              "node.kubernetes.io/windows-build":
                config.windowsRuntime.windowsBuild,
              [config.windowsRuntime.pagefileReadyLabelKey]:
                config.windowsRuntime.pagefileReadyLabelValue,
            }
          : {}),
      },
      tolerations: [
        ...(isWindows
          ? [
              {
                key: "os",
                operator: "Equal",
                value: "windows",
                effect: "NoSchedule",
              },
            ]
          : []),
        {
          key: profile.nodeTaintKey,
          operator: "Equal",
          value: profile.nodeTaintValue,
          effect: "NoSchedule",
        },
      ],
      capabilities: profile.capabilities,
      max_concurrent_sandboxes: profile.maxConcurrency,
      max_concurrent_per_user: null,
      startup_timeout_seconds: isWindows
        ? config.windowsRuntime.startupTimeoutSeconds
        : 300,
      initial_env: isWindows
        ? {
            OH_DEFERRED_INIT: "true",
            OH_ENABLE_VNC: "0",
            LOG_JSON: "true",
            OH_WORKSPACE_PATH: config.windowsRuntime.workingDir,
            OH_CONVERSATIONS_PATH: "C:\\workspace\\.openhands\\conversations",
            OH_BASH_EVENTS_DIR: "C:\\workspace\\.openhands\\bash_events",
            OH_PERSISTENCE_DIR: "C:\\workspace\\.openhands\\persistence",
            OH_CONVERSATION_WORKTREE_ROOT: config.windowsRuntime.worktreeRoot,
            OPENHANDS_ACP_NPM_CACHE_DIR: "C:\\workspace\\.openhands\\npm-cache",
            OPENHANDS_SKILLS_CACHE_DIR:
              "C:\\workspace\\.openhands\\cache\\skills",
            PYTHONUNBUFFERED: "1",
            OH_SANDBOX_OPERATING_SYSTEM: "windows",
          }
        : {
            OH_DEFERRED_INIT: "true",
            OH_ENABLE_VNC: "0",
            LOG_JSON: "true",
            OH_WORKSPACE_PATH: "/workspace/project",
            OH_CONVERSATIONS_PATH: "/workspace/.openhands/conversations",
            OH_BASH_EVENTS_DIR: "/workspace/.openhands/bash_events",
            OH_PERSISTENCE_DIR: "/workspace/.openhands/persistence",
            OH_CONVERSATION_WORKTREE_ROOT: "/workspace/worktrees",
            OPENHANDS_ACP_NPM_CACHE_DIR: "/workspace/.openhands/npm-cache",
            OPENHANDS_SKILLS_CACHE_DIR: "/workspace/.openhands/cache/skills",
            PYTHONUNBUFFERED: "1",
          },
      working_dir: isWindows
        ? config.windowsRuntime.workingDir
        : "/workspace/project",
      command: null,
    };
    return {
      ...bootstrapProfile,
      bootstrap_revision: `sha256:${createHash("sha256")
        .update(JSON.stringify(bootstrapProfile))
        .digest("hex")}`,
    };
  });
}

export function renderWindowsPagefileDaemonSet(environment) {
  const env = config.environments[environment];
  const runtime = config.windowsRuntime;
  const image = externalImageReference(
    runtime.pagefileImageRepository,
    runtime.pagefileImageDigest,
  );
  const sizeMiB = runtime.pagefileSizeGiB * 1024;
  const pagefile = `${runtime.pagefileDrive}\\pagefile.sys`;
  const pagefileScript = `$ErrorActionPreference = "Stop"
$readyPath = "C:\\openhands-pagefile-ready"
$desired = "${pagefile} ${sizeMiB} ${sizeMiB}"
Remove-Item -LiteralPath $readyPath -Force -ErrorAction SilentlyContinue

function Set-PagefileReadyLabel([AllowNull()][string]$value) {
  $tokenPath = "C:\\var\\run\\secrets\\kubernetes.io\\serviceaccount\\token"
  $caPath = "C:\\var\\run\\secrets\\kubernetes.io\\serviceaccount\\ca.crt"
  $token = (Get-Content -LiteralPath $tokenPath -Raw).Trim()
  $jsonValue = if ($null -eq $value) { "null" } else { '"' + $value + '"' }
  $body = '{"metadata":{"labels":{"${runtime.pagefileReadyLabelKey}":' + $jsonValue + '}}}'
  $patchPath = "C:\\openhands-pagefile-node-patch.json"
  Set-Content -LiteralPath $patchPath -Value $body -Encoding Ascii -NoNewline
  $apiServer = "https://$env:KUBERNETES_SERVICE_HOST\`:$env:KUBERNETES_SERVICE_PORT"
  & curl.exe --fail --silent --show-error --ssl-no-revoke --cacert $caPath --header "Authorization: Bearer $token" --header "Content-Type: application/merge-patch+json" --request PATCH --data-binary "@$patchPath" "$apiServer/api/v1/nodes/$env:NODE_NAME" | Out-Null
  Remove-Item -LiteralPath $patchPath -Force -ErrorAction SilentlyContinue
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to update the pagefile readiness label on node $env:NODE_NAME"
  }
}

function Test-PagefileReady {
  $pagingFiles = @((Get-ItemProperty -LiteralPath "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Memory Management" -Name PagingFiles).PagingFiles)
  $usage = Get-CimInstance -ClassName Win32_PageFileUsage | Where-Object Name -eq "${pagefile}"
  return $pagingFiles.Count -eq 1 -and $pagingFiles[0] -eq $desired -and $null -ne $usage -and $usage.AllocatedBaseSize -eq ${sizeMiB}
}

Set-PagefileReadyLabel $null
if (-not (Test-PagefileReady)) {
  if (-not (Test-Path -LiteralPath "${runtime.pagefileDrive}\\" -PathType Container)) {
    throw "Windows resource disk ${runtime.pagefileDrive}\\ is unavailable"
  }
  $computerSystem = Get-CimInstance -ClassName Win32_ComputerSystem
  Set-CimInstance -InputObject $computerSystem -Property @{ AutomaticManagedPagefile = $false } | Out-Null
  New-ItemProperty -LiteralPath "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Memory Management" -Name PagingFiles -PropertyType MultiString -Value @($desired) -Force | Out-Null
  Write-Output "Configured $desired; rebooting the Windows node"
  & C:\\Windows\\System32\\schtasks.exe /Create /TN OpenHandsPagefileReboot /SC ONCE /ST 00:00 /TR "C:\\Windows\\System32\\shutdown.exe /r /t 0 /f /d p:4:1" /RU SYSTEM /F
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to create the host pagefile reboot task"
  }
  & C:\\Windows\\System32\\schtasks.exe /Run /TN OpenHandsPagefileReboot
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to start the host pagefile reboot task"
  }
  Start-Sleep -Seconds 300
  throw "Windows did not reboot after the pagefile configuration changed"
}

& C:\\Windows\\System32\\cmd.exe /d /c "schtasks.exe /Delete /TN OpenHandsPagefileReboot /F >nul 2>&1"
Set-PagefileReadyLabel "${runtime.pagefileReadyLabelValue}"
New-Item -ItemType File -Path $readyPath -Force | Out-Null
while ($true) {
  Start-Sleep -Seconds 60
  if (-not (Test-PagefileReady)) {
    Remove-Item -LiteralPath $readyPath -Force -ErrorAction SilentlyContinue
    Set-PagefileReadyLabel $null
    throw "The fixed ${runtime.pagefileSizeGiB} GiB pagefile invariant no longer holds"
  }
}`;
  const renderedPagefileScript = pagefileScript
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
  const pagefileScriptHash = createHash("sha256")
    .update(pagefileScript)
    .digest("hex");
  return `apiVersion: v1
kind: ServiceAccount
metadata:
  name: openhands-windows-pagefile
  namespace: ${env.namespace}
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: openhands-windows-pagefile
  namespace: ${env.namespace}
data:
  pagefile.ps1: |
${renderedPagefileScript}
---
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: openhands-windows-pagefile
  namespace: ${env.namespace}
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: openhands-windows-pagefile
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 1
  template:
    metadata:
      labels:
        app.kubernetes.io/name: openhands-windows-pagefile
      annotations:
        checksum/pagefile-script: "${pagefileScriptHash}"
    spec:
      hostNetwork: true
      serviceAccountName: openhands-windows-pagefile
      automountServiceAccountToken: true
      terminationGracePeriodSeconds: 0
      nodeSelector:
        kubernetes.io/os: windows
        kubernetes.io/arch: amd64
        agentpool: ${runtime.nodePool}
        node.kubernetes.io/windows-build: "${runtime.windowsBuild}"
      tolerations:
        - key: os
          operator: Equal
          value: windows
          effect: NoSchedule
        - key: ${runtime.nodeTaintKey}
          operator: Equal
          value: ${runtime.nodeTaintValue}
          effect: NoSchedule
      securityContext:
        windowsOptions:
          hostProcess: true
          runAsUserName: "NT AUTHORITY\\\\SYSTEM"
      volumes:
        - name: pagefile-script
          configMap:
            name: openhands-windows-pagefile
      containers:
        - name: pagefile
          image: ${image}
          imagePullPolicy: IfNotPresent
          env:
            - name: NODE_NAME
              valueFrom:
                fieldRef:
                  fieldPath: spec.nodeName
          command:
            - powershell.exe
            - -NoLogo
            - -NoProfile
            - -NonInteractive
            - -File
            - C:\\pagefile-bootstrap\\pagefile.ps1
          volumeMounts:
            - name: pagefile-script
              mountPath: C:\\pagefile-bootstrap
              readOnly: true
          readinessProbe:
            exec:
              command:
                - powershell.exe
                - -NoLogo
                - -NoProfile
                - -NonInteractive
                - -Command
                - if (Test-Path -LiteralPath "C:\\openhands-pagefile-ready" -PathType Leaf) { exit 0 } else { exit 1 }
            initialDelaySeconds: 5
            periodSeconds: 10
            failureThreshold: 6
          securityContext:
            windowsOptions:
              hostProcess: true
              runAsUserName: "NT AUTHORITY\\\\SYSTEM"
`;
}

export function renderSandboxSpecBootstrapConfigMap(
  environment,
  sandboxRuntimeDigest,
  windowsRuntimeDigest,
) {
  const env = config.environments[environment];
  const json = sandboxSpecBootstrapJson(
    environment,
    sandboxRuntimeDigest,
    windowsRuntimeDigest,
  )
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
  return `apiVersion: v1
kind: ConfigMap
metadata:
  name: openhands-sandbox-spec-bootstrap
  namespace: ${env.namespace}
data:
  sandbox-specs.json: |
${json}
`;
}

function sandboxSpecBootstrapJson(
  environment,
  agentServerDigest,
  windowsRuntimeDigest,
) {
  return JSON.stringify(
    sandboxSpecBootstrapProfiles(
      environment,
      agentServerDigest,
      windowsRuntimeDigest,
    ),
    null,
    2,
  );
}

export function renderWindowsRuntimePreflight(
  environment,
  windowsRuntimeDigest,
) {
  const env = config.environments[environment];
  const runtime = config.windowsRuntime;
  const image = externalImageReference(
    runtime.imageRepository,
    windowsRuntimeDigest,
  );
  return `apiVersion: batch/v1
kind: Job
metadata:
  name: openhands-windows-runtime-preflight
  namespace: ${env.namespace}
spec:
  activeDeadlineSeconds: 1800
  backoffLimit: 0
  ttlSecondsAfterFinished: 600
  template:
    metadata:
      labels:
        azure.workload.identity/use: "true"
        openhands.dev/execution-profile: ${runtime.runtimeIdentity}
    spec:
      restartPolicy: Never
      serviceAccountName: ${env.serviceAccount}
      nodeSelector:
        kubernetes.io/os: windows
        kubernetes.io/arch: amd64
        agentpool: ${runtime.nodePool}
        node.kubernetes.io/windows-build: "${runtime.windowsBuild}"
        ${runtime.pagefileReadyLabelKey}: "${runtime.pagefileReadyLabelValue}"
      tolerations:
        - key: os
          operator: Equal
          value: windows
          effect: NoSchedule
        - key: ${runtime.nodeTaintKey}
          operator: Equal
          value: ${runtime.nodeTaintValue}
          effect: NoSchedule
      containers:
        - name: verify-runtime
          image: ${image}
          imagePullPolicy: Always
          command:
            - C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe
            - -NoLogo
            - -NoProfile
            - -Command
            - |
              $ErrorActionPreference = "Stop"
              if ([string]::IsNullOrWhiteSpace($env:AZURE_FEDERATED_TOKEN_FILE)) {
                throw "Azure Workload Identity did not inject AZURE_FEDERATED_TOKEN_FILE"
              }
              if (-not (Test-Path -LiteralPath $env:AZURE_FEDERATED_TOKEN_FILE -PathType Leaf)) {
                throw "Azure Workload Identity token file is missing at $env:AZURE_FEDERATED_TOKEN_FILE"
              }
              $token = [IO.File]::ReadAllText($env:AZURE_FEDERATED_TOKEN_FILE)
              if ([string]::IsNullOrWhiteSpace($token)) {
                throw "Azure Workload Identity token file is empty"
              }
              if (-not (Get-Command powershell.exe -ErrorAction SilentlyContinue)) {
                throw "powershell.exe is not discoverable through PATH"
              }
              if (-not (Get-Command p4.exe -ErrorAction SilentlyContinue)) {
                throw "p4.exe is not discoverable through PATH"
              }
              if (-not (Get-Command p4-mcp-server.exe -ErrorAction SilentlyContinue)) {
                throw "p4-mcp-server.exe is not discoverable through PATH"
              }
              if (-not (Get-Command copilot.exe -ErrorAction SilentlyContinue)) {
                throw "copilot.exe is not discoverable through PATH"
              }
              & copilot.exe --no-auto-update help acp | Out-Null
              Write-Output "Windows runtime image, Perforce and Copilot tools, and Workload Identity token injection verified"
`;
}

export function windowsRuntimeImportTag(windowsRuntimeDigest) {
  return `sha256-${normalizeDigest(windowsRuntimeDigest).slice("sha256:".length)}`;
}

export function renderWindowsPagefileRbac(environment) {
  const env = config.environments[environment];
  return `apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: openhands-windows-pagefile
rules:
  - apiGroups: [""]
    resources: ["nodes"]
    verbs: ["get", "patch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: openhands-windows-pagefile-${environment}
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: openhands-windows-pagefile
subjects:
  - kind: ServiceAccount
    name: openhands-windows-pagefile
    namespace: ${env.namespace}
`;
}

export function renderWindowsRuntimeImport(windowsRuntimeDigest) {
  const digest = normalizeDigest(windowsRuntimeDigest);
  const runtime = config.windowsRuntime;
  const source = externalImageReference(runtime.sourceImageRepository, digest);
  const tag = windowsRuntimeImportTag(digest);
  return `apiVersion: batch/v1
kind: Job
metadata:
  name: openhands-windows-runtime-import
  namespace: ${config.build.namespace}
spec:
  activeDeadlineSeconds: 1800
  backoffLimit: 0
  ttlSecondsAfterFinished: 600
  template:
    metadata:
      labels:
        azure.workload.identity/use: "true"
        app.kubernetes.io/name: openhands-windows-runtime-import
    spec:
      restartPolicy: Never
      serviceAccountName: ${config.build.windowsRuntimeImporterServiceAccount}
      nodeSelector:
        kubernetes.io/os: linux
        kubernetes.io/arch: amd64
        agentpool: ${config.build.nodePool}
      tolerations:
        - key: ${config.build.nodeTaintKey}
          operator: Equal
          value: ${config.build.nodeTaintValue}
          effect: NoSchedule
      containers:
        - name: import-runtime
          image: ${config.build.azureCliImage}
          command: ["/bin/sh", "-ec"]
          args:
            - |
              token="$(cat "$AZURE_FEDERATED_TOKEN_FILE")"
              az login --service-principal --username "$AZURE_CLIENT_ID" --tenant "$AZURE_TENANT_ID" --federated-token "$token" --output none
              az acr import \
                --name ${config.azure.acrName} \
                --source ${source} \
                --image ${runtime.repository}:${tag} \
                --force \
                --output none
              imported_digest="$(az acr manifest show-metadata \
                --registry ${config.azure.acrName} \
                --name ${runtime.repository}@${digest} \
                --query digest \
                --output tsv)"
              test "$imported_digest" = "${digest}"
              printf 'WINDOWS_RUNTIME_ACR_IMAGE=%s\\n' "${runtime.imageRepository}@${digest}"
`;
}

export function renderSandboxServerResources(
  environment,
  digest,
  runtimeDigest,
  agentServerDigest,
  runtimeClientId,
  windowsRuntimeDigest,
) {
  const env = config.environments[environment];
  const sandbox = config.sandboxServer;
  const image = imageReference(
    config.azure.acrLoginServer,
    config.build.sandboxServerRepository,
    digest,
  );
  const runtimeImage = imageReference(
    config.azure.acrLoginServer,
    config.build.sandboxRuntimeRepository,
    runtimeDigest,
  );
  const windowsRuntimeImage = externalImageReference(
    config.windowsRuntime.imageRepository,
    windowsRuntimeDigest,
  );
  const sandboxSpecBootstrapChecksum = createHash("sha256")
    .update(
      sandboxSpecBootstrapJson(
        environment,
        agentServerDigest,
        windowsRuntimeDigest,
      ),
    )
    .digest("hex");
  const githubOAuthEnv =
    env.githubApp.slug &&
    env.githubApp.secrets.clientId &&
    env.githubApp.secrets.clientSecret
      ? `            - name: GITHUB_APP_CLIENT_ID
              valueFrom:
                secretKeyRef:
                  name: openhands-halo-secrets
                  key: githubAppClientId
            - name: GITHUB_APP_CLIENT_SECRET
              valueFrom:
                secretKeyRef:
                  name: openhands-halo-secrets
                  key: githubAppClientSecret
            - name: GITHUB_APP_SLUG
              value: ${env.githubApp.slug}
            - name: OH_GITHUB_OAUTH_CALLBACK_URL
              value: https://${env.frontDoorHost}/oauth/github/callback
            - name: OH_GITHUB_OAUTH_SUCCESS_URL
              value: https://${env.frontDoorHost}/settings/app
`
      : "";
  const sandboxStartupTimeoutEnv =
    environment === "candidate"
      ? `            - name: OH_APP_CONVERSATION_SANDBOX_STARTUP_TIMEOUT
              value: "600"
            - name: OH_APP_CONVERSATION_SANDBOX_STARTUP_INACTIVITY_TIMEOUT
              value: "600"
`
      : "";
  const agentProfileSeeds = JSON.stringify(sandbox.agentProfileSeeds);
  const hindsightEnv = hindsightBrokerEnv(environment);
  const hindsightVolumeMount = env.hindsight?.enabled
    ? `            - name: hindsight-secrets-store
              mountPath: /mnt/hindsight-secrets
              readOnly: true
`
    : "";
  const hindsightVolume = env.hindsight?.enabled
    ? `        - name: hindsight-secrets-store
          csi:
            driver: secrets-store.csi.k8s.io
            readOnly: true
            volumeAttributes:
              secretProviderClass: openhands-hindsight-broker-secrets
`
    : "";
  const rbacBootstrapEnv = env.rbac?.secrets?.bootstrapJson
    ? `            - name: OH_RBAC_BOOTSTRAP_JSON_FILE
              value: /mnt/rbac-bootstrap-secrets/rbacBootstrapJson
`
    : "";
  const rbacBootstrapVolumeMount = env.rbac?.secrets?.bootstrapJson
    ? `            - name: rbac-bootstrap-secrets-store
              mountPath: /mnt/rbac-bootstrap-secrets
              readOnly: true
`
    : "";
  const rbacBootstrapVolume = env.rbac?.secrets?.bootstrapJson
    ? `        - name: rbac-bootstrap-secrets-store
          csi:
            driver: secrets-store.csi.k8s.io
            readOnly: true
            volumeAttributes:
              secretProviderClass: openhands-rbac-bootstrap-secrets
`
    : "";
  return `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${sandbox.serviceName}
  namespace: ${env.namespace}
spec:
  replicas: ${sandbox.replicas}
  selector:
    matchLabels:
      app.kubernetes.io/name: ${sandbox.serviceName}
  template:
    metadata:
      annotations:
        openhands.dev/sandbox-spec-bootstrap-sha256: ${sandboxSpecBootstrapChecksum}
      labels:
        app.kubernetes.io/name: ${sandbox.serviceName}
        azure.workload.identity/use: "true"
    spec:
      serviceAccountName: ${env.serviceAccount}
      nodeSelector:
        kubernetes.io/os: linux
        kubernetes.io/arch: amd64
        agentpool: ${config.runtime.nodePool}
      tolerations:
        - key: ${config.runtime.nodeTaintKey}
          operator: Equal
          value: ${config.runtime.nodeTaintValue}
          effect: NoSchedule
      containers:
        - name: sandbox-server
          image: ${image}
          imagePullPolicy: IfNotPresent
          ports:
            - name: http
              containerPort: ${sandbox.port}
          env:
            - name: AZURE_CLIENT_ID
              value: ${runtimeClientId}
            - name: RUNTIME
              value: kubernetes
            - name: AGENT_SERVER_IMAGE
              value: ${runtimeImage}
            - name: OH_WINDOWS_AGENT_SERVER_IMAGE
              value: ${windowsRuntimeImage}
            - name: OH_SANDBOX_SPEC_BOOTSTRAP_FILE
              value: /etc/openhands/sandbox-specs.json
            - name: OH_HALO_DURABLE_STATE_PVC
              value: ${env.conversationPvc}
${sandboxStartupTimeoutEnv}            - name: SERVE_FRONTEND
              value: "false"
            - name: DB_AZURE_IDENTITY
              value: "true"
            - name: DB_HOST
              value: ${config.postgres.fqdn}
            - name: DB_PORT
              value: "5432"
            - name: DB_NAME
              value: ${env.database}
            - name: DB_USER
              value: ${env.runtimeIdentity}
            - name: DB_SSL_MODE
              value: require
            - name: LLM_MODEL
              value: azure/${config.azureOpenAI.deployment}
            - name: LLM_BASE_URL
              value: ${config.azureOpenAI.endpoint}
            - name: LLM_API_VERSION
              value: ${config.azureOpenAI.apiVersion}
            - name: LLM_AUTH_TYPE
              value: azure_workload_identity
            - name: FOUNDRY_WEB_SEARCH_MCP_ENDPOINT
              value: ${config.foundry.webSearchMcpEndpoint}
            - name: FOUNDRY_WEB_SEARCH_MCP_AUTH_TYPE
              value: ${config.foundry.webSearchMcpAuthType}
            - name: HIDE_LLM_SETTINGS
              value: "false"
            - name: OH_ALLOW_USER_LLM_CONFIGURATION
              value: "true"
            - name: OH_ORGANIZATION_AGENT_PROFILE_SEEDS_JSON
              value: >-
                ${agentProfileSeeds}
            - name: OH_TRUSTED_IDENTITY_ASSERTION_SECRET
              valueFrom:
                secretKeyRef:
                  name: openhands-halo-secrets
                  key: trustedIdentityAssertion
            - name: OH_SECRET_KEY
              valueFrom:
                secretKeyRef:
                  name: openhands-agent-server-bootstrap
                  key: secret-key
            - name: OH_TRUSTED_IDENTITY_ASSERTION_ISSUER
              value: ${sandbox.trustedIdentityIssuer}
            - name: OH_TRUSTED_IDENTITY_ASSERTION_AUDIENCE
              value: ${sandbox.trustedIdentityAudience}
            - name: OH_TRUSTED_IDENTITY_ASSERTION_HEADER
              value: ${sandbox.trustedIdentityHeader}
            - name: OH_TRUSTED_IDENTITY_ASSERTION_MAX_LIFETIME_SECONDS
              value: "${sandbox.trustedIdentityMaxLifetimeSeconds}"
            - name: OH_TRUSTED_IDENTITY_ASSERTION_CLOCK_SKEW_SECONDS
              value: "${sandbox.trustedIdentityClockSkewSeconds}"
            - name: JWT_SECRET
              valueFrom:
                secretKeyRef:
                  name: openhands-halo-secrets
                  key: jwtSecret
${githubOAuthEnv}            - name: OH_SANDBOX_KIND
              value: openhands.app_server.sandbox.kubernetes_sandbox_service.KubernetesSandboxServiceInjector
            - name: OH_SANDBOX_SPEC_KIND
              value: openhands.app_server.sandbox.kubernetes_sandbox_spec_service.KubernetesSandboxSpecServiceInjector
            - name: OH_SANDBOX_NAMESPACE
              value: ${env.namespace}
            - name: OH_SANDBOX_CLAIM_NAME_PREFIX
              value: ${sandbox.claimNamePrefix}
            - name: OH_SANDBOX_WEBHOOK_BASE_URL
              value: http://${sandbox.serviceName}:${sandbox.port}
            - name: OH_SANDBOX_SANDBOX_URL_PATTERN
              value: https://${env.frontDoorHost}/sandboxes/{sandbox_name}
            - name: OH_WEB_URL
              value: https://${env.frontDoorHost}
            - name: OH_PERMITTED_CORS_ORIGINS_0
              value: https://${env.frontDoorHost}
${rbacBootstrapEnv}${hindsightEnv}          readinessProbe:
            httpGet:
              path: /ready
              port: http
            initialDelaySeconds: 10
            periodSeconds: 5
          livenessProbe:
            httpGet:
              path: /alive
              port: http
            initialDelaySeconds: 30
            periodSeconds: 10
          resources:
            requests:
              cpu: 250m
              memory: 512Mi
            limits:
              cpu: "1"
              memory: 2Gi
          volumeMounts:
            - name: sandbox-spec-bootstrap
              mountPath: /etc/openhands
              readOnly: true
${rbacBootstrapVolumeMount}${hindsightVolumeMount}      volumes:
        - name: sandbox-spec-bootstrap
          configMap:
            name: openhands-sandbox-spec-bootstrap
${rbacBootstrapVolume}${hindsightVolume}---
apiVersion: v1
kind: Service
metadata:
  name: ${sandbox.serviceName}
  namespace: ${env.namespace}
spec:
  selector:
    app.kubernetes.io/name: ${sandbox.serviceName}
  ports:
    - name: http
      port: ${sandbox.port}
      targetPort: http
`;
}

function reportWindowsRuntimePreflightFailure(environment) {
  const namespace = config.environments[environment].namespace;
  for (const args of [
    [
      "-n",
      namespace,
      "get",
      "pods",
      "-l",
      "job-name=openhands-windows-runtime-preflight",
      "-o",
      "wide",
    ],
    ["-n", namespace, "describe", "job", "openhands-windows-runtime-preflight"],
    [
      "-n",
      namespace,
      "logs",
      "job/openhands-windows-runtime-preflight",
      "--all-containers=true",
    ],
  ]) {
    const result = tryRun("kubectl", args);
    if (result.stdout) process.stderr.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
}

function reportWindowsRuntimeImportFailure() {
  for (const args of [
    [
      "-n",
      config.build.namespace,
      "get",
      "pods",
      "-l",
      "job-name=openhands-windows-runtime-import",
      "-o",
      "wide",
    ],
    [
      "-n",
      config.build.namespace,
      "describe",
      "job",
      "openhands-windows-runtime-import",
    ],
    [
      "-n",
      config.build.namespace,
      "logs",
      "job/openhands-windows-runtime-import",
      "--all-containers=true",
    ],
  ]) {
    const result = tryRun("kubectl", args);
    if (result.stdout) process.stderr.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
}

export function windowsPreflightJobResult(job) {
  const conditions = job.status?.conditions ?? [];
  const complete = conditions.find(
    (condition) => condition.type === "Complete" && condition.status === "True",
  );
  if (complete) return { status: "complete" };
  const failed = conditions.find(
    (condition) => condition.type === "Failed" && condition.status === "True",
  );
  if (failed) {
    return {
      status: "failed",
      detail:
        [failed.reason, failed.message].filter(Boolean).join(": ") ||
        "Windows runtime preflight Job failed",
    };
  }
  return { status: "pending" };
}

async function waitForWindowsRuntimeImport() {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const job = JSON.parse(
      kubectl(
        [
          "-n",
          config.build.namespace,
          "get",
          "job",
          "openhands-windows-runtime-import",
          "-o",
          "json",
        ],
        { capture: true },
      ),
    );
    const result = windowsPreflightJobResult(job);
    if (result.status === "complete") return;
    if (result.status === "failed") throw new Error(result.detail);
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  throw new Error(
    "Timed out after 1800 seconds waiting for the Windows runtime ACR import",
  );
}

async function importWindowsRuntime(windowsRuntimeDigest) {
  kubectl([
    "-n",
    config.build.namespace,
    "delete",
    "job",
    "openhands-windows-runtime-import",
    "--ignore-not-found",
    "--wait=true",
  ]);
  kubectl(["apply", "-f", "-"], {
    input: renderWindowsRuntimeImport(windowsRuntimeDigest),
  });
  try {
    await waitForWindowsRuntimeImport();
    kubectl([
      "-n",
      config.build.namespace,
      "logs",
      "job/openhands-windows-runtime-import",
      "--all-containers=true",
    ]);
  } catch (error) {
    reportWindowsRuntimeImportFailure();
    throw new Error(
      `Windows runtime ACR import failed; the profile remains undeployed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function waitForWindowsRuntimePreflight(environment) {
  const namespace = config.environments[environment].namespace;
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const job = JSON.parse(
      kubectl(
        [
          "-n",
          namespace,
          "get",
          "job",
          "openhands-windows-runtime-preflight",
          "-o",
          "json",
        ],
        { capture: true },
      ),
    );
    const result = windowsPreflightJobResult(job);
    if (result.status === "complete") return;
    if (result.status === "failed") throw new Error(result.detail);
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  throw new Error(
    "Timed out after 1800 seconds waiting for the Windows runtime image pull and Workload Identity preflight",
  );
}

async function preflightWindowsRuntime(environment, windowsRuntimeDigest) {
  const namespace = config.environments[environment].namespace;
  await importWindowsRuntime(windowsRuntimeDigest);
  kubectl(["apply", "-f", "-"], {
    input: renderWindowsPagefileDaemonSet(environment),
  });
  kubectl([
    "-n",
    namespace,
    "rollout",
    "status",
    "daemonset/openhands-windows-pagefile",
    "--timeout=30m",
  ]);
  kubectl([
    "-n",
    namespace,
    "delete",
    "job",
    "openhands-windows-runtime-preflight",
    "--ignore-not-found",
    "--wait=true",
  ]);
  kubectl(["apply", "-f", "-"], {
    input: renderWindowsRuntimePreflight(environment, windowsRuntimeDigest),
  });
  try {
    await waitForWindowsRuntimePreflight(environment);
    kubectl([
      "-n",
      namespace,
      "logs",
      "job/openhands-windows-runtime-preflight",
      "--all-containers=true",
    ]);
  } catch (error) {
    reportWindowsRuntimePreflightFailure(environment);
    throw new Error(
      `Windows runtime preflight failed; the profile remains undeployed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function yamlSingleQuoted(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function renderSandboxProfileTemplate(
  env,
  profile,
  linuxAgentServerImage,
  windowsAgentServerImage,
) {
  const isWindows = profile.os === "windows";
  const image = isWindows ? windowsAgentServerImage : linuxAgentServerImage;
  const workingDir = isWindows
    ? config.windowsRuntime.workingDir
    : "/workspace/project";
  const workspacePath = isWindows
    ? config.windowsRuntime.workspacePath
    : "/workspace";
  const renderedWorkingDir = isWindows
    ? yamlSingleQuoted(workingDir)
    : workingDir;
  const renderedWorkspacePath = isWindows
    ? yamlSingleQuoted(workspacePath)
    : workspacePath;
  const readinessPath = isWindows ? "/ready" : "/health";
  const linuxSecurityContext = isWindows
    ? ""
    : `      securityContext:
        runAsUser: 10001
        runAsGroup: 10001
        fsGroup: 10001
`;
  const workspaceInit = isWindows
    ? `      initContainers:
        - name: workspace-permissions
          image: ${image}
          command: ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]
          args:
            - |
              $ErrorActionPreference = 'Stop'
              New-Item -ItemType Directory -Force C:\\workspace\\project, C:\\workspace\\worktrees | Out-Null
              icacls C:\\workspace /grant '*S-1-5-93-2-1:(OI)(CI)M' /T /C | Out-Null
          workingDir: 'C:\\'
          securityContext:
            windowsOptions:
              runAsUserName: "ContainerAdministrator"
          volumeMounts:
            - name: workspace
              mountPath: 'C:\\workspace'
`
    : `      initContainers:
        - name: workspace-permissions
          image: ${image}
          command: ["/bin/sh", "-ec"]
          args:
            - |
              mkdir -p /workspace/project /workspace/worktrees /workspace/.openhands/npm-cache /workspace/.openhands/cache/skills
              chown 10001:10001 /workspace/project /workspace/worktrees /workspace/.openhands /workspace/.openhands/npm-cache /workspace/.openhands/cache /workspace/.openhands/cache/skills
              chmod 2775 /workspace/project /workspace/worktrees /workspace/.openhands
              chmod 0700 /workspace/.openhands/npm-cache /workspace/.openhands/cache /workspace/.openhands/cache/skills
          securityContext:
            runAsUser: 0
            runAsGroup: 0
            allowPrivilegeEscalation: false
          volumeMounts:
            - name: workspace
              mountPath: /workspace
`;
  const vscodePort = isWindows
    ? ""
    : `            - containerPort: 8001
              name: vscode
`;
  const privateEgress = (config.network.sandboxPrivateEgress ?? [])
    .map((rule) => {
      const [address, prefix] = String(rule.cidr ?? "").split("/");
      const protocol = String(rule.protocol ?? "").toUpperCase();
      const port = Number(rule.port);
      if (
        isIP(address) !== 4 ||
        !/^(?:[0-9]|[12][0-9]|3[0-2])$/.test(prefix ?? "")
      ) {
        throw new Error(`Invalid sandbox private egress CIDR: ${rule.cidr}`);
      }
      if (!["TCP", "UDP"].includes(protocol)) {
        throw new Error(
          `Invalid sandbox private egress protocol: ${rule.protocol}`,
        );
      }
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`Invalid sandbox private egress port: ${rule.port}`);
      }
      return `      - to:
          - ipBlock:
              cidr: ${rule.cidr}
        ports:
          - protocol: ${protocol}
            port: ${port}
`;
    })
    .join("");
  const anyDestinationEgress = (
    config.network.sandboxAnyDestinationEgress ?? []
  )
    .map((rule) => {
      const protocol = String(rule.protocol ?? "").toUpperCase();
      const port = Number(rule.port);
      if (!["TCP", "UDP"].includes(protocol)) {
        throw new Error(
          `Invalid sandbox any-destination egress protocol: ${rule.protocol}`,
        );
      }
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(
          `Invalid sandbox any-destination egress port: ${rule.port}`,
        );
      }
      return `      - ports:
          - protocol: ${protocol}
            port: ${port}
`;
    })
    .join("");
  return `apiVersion: extensions.agents.x-k8s.io/v1beta1
kind: SandboxTemplate
metadata:
  name: ${profile.template}
  namespace: ${env.namespace}
  labels:
    openhands.dev/execution-profile: ${profile.id}
    openhands.dev/os: ${profile.os}
    openhands.dev/resource-class: ${profile.resourceClass}
spec:
  volumeClaimTemplatesPolicy: Overrides
  envVarsInjectionPolicy: Allowed
  service: true
  networkPolicy:
    ingress:
      - from:
          - podSelector:
              matchLabels:
                app.kubernetes.io/name: ${config.sandboxServer.serviceName}
          - podSelector:
              matchLabels:
                app.kubernetes.io/name: agent-canvas
        ports:
          - protocol: TCP
            port: 8000
    egress:
      - to:
          - namespaceSelector:
              matchLabels:
                kubernetes.io/metadata.name: kube-system
        ports:
          - protocol: UDP
            port: 53
          - protocol: TCP
            port: 53
      - to:
          - podSelector:
              matchLabels:
                app.kubernetes.io/name: ${config.sandboxServer.serviceName}
        ports:
          - protocol: TCP
            port: ${config.sandboxServer.port}
      - ports:
          - protocol: TCP
            port: 80
          - protocol: TCP
            port: 443
${anyDestinationEgress}${privateEgress}  volumeClaimTemplates:
    - metadata:
        name: workspace
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: ${profile.storageClass}
        resources:
          requests:
            storage: ${profile.storageSize}
  podTemplate:
    metadata:
      labels:
        azure.workload.identity/use: "true"
        openhands.dev/execution-profile: ${profile.id}
    spec:
      serviceAccountName: ${env.serviceAccount}
      nodeSelector:
        kubernetes.io/os: ${profile.os}
        kubernetes.io/arch: amd64
        agentpool: ${profile.nodePool}
${isWindows ? `        node.kubernetes.io/windows-build: "${config.windowsRuntime.windowsBuild}"\n        ${config.windowsRuntime.pagefileReadyLabelKey}: "${config.windowsRuntime.pagefileReadyLabelValue}"\n` : ""}      tolerations:
${
  isWindows
    ? `        - key: os
          operator: Equal
          value: windows
          effect: NoSchedule
`
    : ""
}
        - key: ${profile.nodeTaintKey}
          operator: Equal
          value: ${profile.nodeTaintValue}
          effect: NoSchedule
${linuxSecurityContext}${workspaceInit}      containers:
        - name: agent-server
          image: ${image}
          args: ["--host", "0.0.0.0", "--port", "8000"]
          workingDir: ${renderedWorkingDir}
          env:
            - name: OH_DEFERRED_INIT
              value: "true"
            - name: OH_SECRET_KEY
              valueFrom:
                secretKeyRef:
                  name: openhands-agent-server-bootstrap
                  key: secret-key
          ports:
            - containerPort: 8000
              name: agent-server
${vscodePort}          readinessProbe:
            httpGet:
              path: ${readinessPath}
              port: 8000
            initialDelaySeconds: 3
            periodSeconds: 3
            failureThreshold: 60
          resources:
            requests:
              cpu: ${quote(profile.cpuRequest)}
              memory: ${profile.memoryRequest}
            limits:
              cpu: ${quote(profile.cpuLimit)}
              memory: ${profile.memoryLimit}
          volumeMounts:
            - name: workspace
              mountPath: ${renderedWorkspacePath}
---
apiVersion: extensions.agents.x-k8s.io/v1beta1
kind: SandboxWarmPool
metadata:
  name: ${profile.warmPool}
  namespace: ${env.namespace}
spec:
  replicas: ${profile.warmPoolReplicas}
  sandboxTemplateRef:
    name: ${profile.template}
`;
}

export function renderAgentSandboxResources(
  environment,
  sandboxRuntimeDigest,
  windowsRuntimeDigest,
) {
  const env = config.environments[environment];
  const linuxAgentServerImage = imageReference(
    config.azure.acrLoginServer,
    config.build.sandboxRuntimeRepository,
    sandboxRuntimeDigest,
  );
  const windowsAgentServerImage = externalImageReference(
    config.windowsRuntime.imageRepository,
    windowsRuntimeDigest,
  );
  const profiles = config.agentSandbox.profileSeeds;
  return `${profiles
    .map((profile) =>
      renderSandboxProfileTemplate(
        env,
        profile,
        linuxAgentServerImage,
        windowsAgentServerImage,
      ),
    )
    .join("---\n")}---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: openhands-sandbox-server
  namespace: ${env.namespace}
rules:
  - apiGroups: ["extensions.agents.x-k8s.io"]
    resources: ["sandboxclaims"]
    verbs: ["create", "get", "list", "watch", "delete"]
  - apiGroups: ["extensions.agents.x-k8s.io"]
    resources: ["sandboxtemplates", "sandboxwarmpools"]
    verbs: ["get"]
  - apiGroups: ["agents.x-k8s.io"]
    resources: ["sandboxes"]
    verbs: ["get", "list", "watch", "patch"]
  - apiGroups: [""]
    resources: ["pods", "persistentvolumeclaims", "events"]
    verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: openhands-sandbox-server
  namespace: ${env.namespace}
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: openhands-sandbox-server
subjects:
  - kind: ServiceAccount
    name: ${env.serviceAccount}
    namespace: ${env.namespace}
`;
}

export function renderPostgresBootstrapJob(runtimeIdentities) {
  const postgres = config.postgres;
  const roles = Object.entries(config.environments)
    .map(([environment, env]) => {
      const principalId = runtimeIdentities[environment]?.principalId;
      if (!principalId) {
        throw new Error(
          `Missing PostgreSQL runtime identity for ${environment}`,
        );
      }
      return `              if ! psql --tuples-only --no-align --command \\
                "SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = '${env.runtimeIdentity}'" |
                grep -qx 1; then
                psql --set ON_ERROR_STOP=1 --command \\
                  "SELECT pg_catalog.pgaadauth_create_principal_with_oid('${env.runtimeIdentity}', '${principalId}', 'service', false, false)"
              fi
              psql --set ON_ERROR_STOP=1 --command \\
                'ALTER DATABASE ${env.database} OWNER TO "${env.runtimeIdentity}"'
              psql --set ON_ERROR_STOP=1 --dbname ${env.database} --command \\
                'GRANT USAGE, CREATE ON SCHEMA public TO "${env.runtimeIdentity}"'`;
    })
    .join("\n");
  const hindsightRoles = Object.entries(config.environments)
    .filter(([, env]) => env.hindsight?.enabled)
    .map(([environment, env]) => {
      const hindsight = env.hindsight;
      return `              hindsight_password="$(cat /hindsight-secrets/${environment}HindsightDatabasePassword)"
              psql --set ON_ERROR_STOP=1 <<'SQL'
              DO $$
              BEGIN
                IF NOT EXISTS (
                  SELECT 1 FROM pg_catalog.pg_roles
                  WHERE rolname = '${hindsight.databaseUser}'
                ) THEN
                  CREATE ROLE "${hindsight.databaseUser}" LOGIN;
                END IF;
              END
              $$;
              SQL
              psql --set ON_ERROR_STOP=1 --set=hindsight_password="$hindsight_password" <<'SQL'
              ALTER ROLE "${hindsight.databaseUser}" WITH LOGIN PASSWORD :'hindsight_password';
              SQL
              psql --set ON_ERROR_STOP=1 --command \\
                'ALTER DATABASE ${hindsight.database} OWNER TO "${hindsight.databaseUser}"'
              psql --set ON_ERROR_STOP=1 --dbname ${hindsight.database} --command \\
                'CREATE EXTENSION IF NOT EXISTS vector'
              psql --set ON_ERROR_STOP=1 --dbname ${hindsight.database} --command \\
                'CREATE EXTENSION IF NOT EXISTS pg_trgm'
              psql --set ON_ERROR_STOP=1 --dbname ${hindsight.database} --command \\
                'CREATE SCHEMA IF NOT EXISTS ${config.hindsight.databaseSchema} AUTHORIZATION "${hindsight.databaseUser}"'
              psql --set ON_ERROR_STOP=1 --dbname ${hindsight.database} --command \\
                'GRANT ALL ON SCHEMA ${config.hindsight.databaseSchema} TO "${hindsight.databaseUser}"'`;
    })
    .join("\n");
  return `apiVersion: batch/v1
kind: Job
metadata:
  name: halo-postgres-bootstrap
  namespace: ${config.build.namespace}
spec:
  backoffLimit: 0
  ttlSecondsAfterFinished: 600
  template:
    metadata:
      labels:
        azure.workload.identity/use: "true"
    spec:
      restartPolicy: Never
      serviceAccountName: ${postgres.bootstrapServiceAccount}
      nodeSelector:
        kubernetes.io/os: linux
        kubernetes.io/arch: amd64
        agentpool: ${config.runtime.nodePool}
      tolerations:
        - key: ${config.runtime.nodeTaintKey}
          operator: Equal
          value: ${config.runtime.nodeTaintValue}
          effect: NoSchedule
      initContainers:
        - name: azure-token
          image: ${config.build.azureCliImage}
          command: ["/bin/sh", "-ec"]
          args:
            - |
              token="$(cat "$AZURE_FEDERATED_TOKEN_FILE")"
              az login \\
                --service-principal \\
                --username "$AZURE_CLIENT_ID" \\
                --tenant "$AZURE_TENANT_ID" \\
                --federated-token "$token" \\
                --allow-no-subscriptions \\
                --output none
              az account get-access-token \\
                --resource-type oss-rdbms \\
                --query accessToken \\
                --output tsv > /auth/token
              chmod 0400 /auth/token
          volumeMounts:
            - name: auth
              mountPath: /auth
      containers:
        - name: postgres
          image: postgres:16-alpine
          command: ["/bin/sh", "-ec"]
          args:
            - |
              export PGPASSWORD="$(cat /auth/token)"
${roles}
${hindsightRoles}
          env:
            - name: PGHOST
              value: ${postgres.fqdn}
            - name: PGPORT
              value: "5432"
            - name: PGDATABASE
              value: postgres
            - name: PGUSER
              value: ${config.identities.postgresBootstrap}
            - name: PGSSLMODE
              value: require
          volumeMounts:
            - name: auth
              mountPath: /auth
              readOnly: true
            - name: hindsight-secrets
              mountPath: /hindsight-secrets
              readOnly: true
      volumes:
        - name: auth
          emptyDir:
            medium: Memory
        - name: hindsight-secrets
          csi:
            driver: secrets-store.csi.k8s.io
            readOnly: true
            volumeAttributes:
              secretProviderClass: openhands-halo-postgres-bootstrap-secrets
`;
}

function ensureAgentSandbox() {
  kubectl(["apply", "-f", config.agentSandbox.releaseManifest]);
  kubectl([
    "-n",
    "agent-sandbox-system",
    "patch",
    "deployment",
    "agent-sandbox-controller",
    "--type=merge",
    "-p",
    JSON.stringify({
      spec: {
        template: {
          spec: {
            nodeSelector: {
              "kubernetes.io/os": "linux",
              "kubernetes.io/arch": "amd64",
              agentpool: config.runtime.nodePool,
            },
            tolerations: [
              {
                key: config.runtime.nodeTaintKey,
                operator: "Equal",
                value: config.runtime.nodeTaintValue,
                effect: "NoSchedule",
              },
            ],
          },
        },
      },
    }),
  ]);
  kubectl([
    "-n",
    "agent-sandbox-system",
    "rollout",
    "status",
    "deployment/agent-sandbox-controller",
    "--timeout=240s",
  ]);
}

export function renderConversationStorageClass() {
  const storage = config.conversationStorage;
  return `apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: ${storage.storageClass}
provisioner: file.csi.azure.com
parameters:
  skuName: ${storage.skuName}
reclaimPolicy: Retain
allowVolumeExpansion: true
volumeBindingMode: Immediate
mountOptions:
  - dir_mode=0770
  - file_mode=0660
  - uid=10001
  - gid=10001
  - mfsymlinks
  - cache=strict
  - actimeo=30
`;
}

export function renderConversationPvc(environment) {
  const env = config.environments[environment];
  const storage = config.conversationStorage;
  return `apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ${env.conversationPvc}
  namespace: ${env.namespace}
spec:
  accessModes:
    - ReadWriteMany
  storageClassName: ${storage.storageClass}
  resources:
    requests:
      storage: ${storage.size}
`;
}

export function renderWorkspaceStorageClass(os = "linux") {
  const storage =
    os === "windows" ? config.windowsWorkspaceStorage : config.workspaceStorage;
  const fileSystemParameter =
    os === "windows"
      ? `  csi.storage.k8s.io/fstype: ${storage.fileSystem}\n`
      : "";
  return `apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: ${storage.storageClass}
provisioner: disk.csi.azure.com
parameters:
  skuName: ${storage.skuName}
${fileSystemParameter}reclaimPolicy: Retain
allowVolumeExpansion: true
volumeBindingMode: WaitForFirstConsumer
`;
}

function removeLegacyWorkspaceRuntimeRbac(environment) {
  const env = config.environments[environment];
  kubectl([
    "-n",
    env.namespace,
    "delete",
    "role/openhands-halo-workspace-controller",
    "rolebinding/openhands-halo-workspace-controller",
    "--ignore-not-found",
  ]);
}

function frontDoorCommonArgs() {
  return [
    "--resource-group",
    config.azure.resourceGroup,
    "--profile-name",
    config.azure.frontDoorProfile,
  ];
}

export function frontDoorOriginGroupCreateArgs(environment) {
  const env = config.environments[environment];
  return [
    "afd",
    "origin-group",
    "create",
    ...frontDoorCommonArgs(),
    "--origin-group-name",
    env.frontDoorOriginGroup,
    "--probe-request-type",
    "GET",
    "--probe-protocol",
    "Http",
    "--probe-path",
    "/ready",
    "--probe-interval-in-seconds",
    "30",
    "--sample-size",
    "4",
    "--successful-samples-required",
    "3",
    "--additional-latency-in-milliseconds",
    "50",
    "--output",
    "none",
  ];
}

export function frontDoorOriginCreateArgs(environment) {
  const env = config.environments[environment];
  return [
    "afd",
    "origin",
    "create",
    ...frontDoorCommonArgs(),
    "--origin-group-name",
    env.frontDoorOriginGroup,
    "--origin-name",
    env.frontDoorOrigin,
    "--host-name",
    config.azure.applicationGatewayOriginHost,
    "--origin-host-header",
    env.frontDoorHost,
    "--http-port",
    "80",
    "--https-port",
    "443",
    "--enabled-state",
    "Enabled",
    "--priority",
    "1",
    "--weight",
    "1000",
    "--output",
    "none",
  ];
}

export function appGatewayNsgRuleArgs() {
  return [
    "network",
    "nsg",
    "rule",
    "create",
    "--subscription",
    config.azure.subscriptionId,
    "--resource-group",
    config.azure.resourceGroup,
    "--nsg-name",
    config.azure.applicationGatewayNsg,
    "--name",
    "AllowAzureFrontDoorBackendHttp",
    "--priority",
    "115",
    "--access",
    "Allow",
    "--direction",
    "Inbound",
    "--protocol",
    "Tcp",
    "--source-address-prefixes",
    "AzureFrontDoor.Backend",
    "--source-port-ranges",
    "*",
    "--destination-address-prefixes",
    "*",
    "--destination-port-ranges",
    "80",
    "--output",
    "none",
  ];
}

export function renderFrontDoorWafPolicy() {
  return {
    location: "global",
    sku: {
      name: "Standard_AzureFrontDoor",
    },
    properties: {
      policySettings: {
        enabledState: "Enabled",
        mode: "Prevention",
        requestBodyCheck: "Disabled",
      },
      customRules: {
        rules: [
          {
            name: "AllowTrustedServices",
            priority: 1,
            enabledState: "Enabled",
            ruleType: "MatchRule",
            action: "Allow",
            matchConditions: [
              {
                matchVariable: "RemoteAddr",
                operator: "IPMatch",
                negateCondition: false,
                matchValue: config.azure.allowedServiceCidrs,
              },
            ],
          },
          {
            name: "BlockUnapprovedClients",
            priority: 2,
            enabledState: "Enabled",
            ruleType: "MatchRule",
            action: "Block",
            matchConditions: [
              {
                matchVariable: "RemoteAddr",
                operator: "IPMatch",
                negateCondition: true,
                matchValue: config.azure.allowedClientCidrs,
              },
            ],
          },
        ],
      },
      managedRules: {
        managedRuleSets: [],
      },
    },
  };
}

function frontDoorWafPolicyId() {
  return `/subscriptions/${config.azure.subscriptionId}/resourceGroups/${config.azure.resourceGroup}/providers/Microsoft.Network/frontDoorWebApplicationFirewallPolicies/${config.azure.frontDoorWafPolicy}`;
}

function frontDoorSecurityPolicyId() {
  return `/subscriptions/${config.azure.subscriptionId}/resourceGroups/${config.azure.resourceGroup}/providers/Microsoft.Cdn/profiles/${config.azure.frontDoorProfile}/securityPolicies/${config.azure.frontDoorSecurityPolicy}`;
}

export function renderFrontDoorSecurityPolicy(endpointIds) {
  return {
    properties: {
      parameters: {
        type: "WebApplicationFirewall",
        wafPolicy: {
          id: frontDoorWafPolicyId(),
        },
        associations: [
          {
            domains: endpointIds.map((id) => ({ id })),
            patternsToMatch: ["/*"],
          },
        ],
      },
    },
  };
}

function azurePut(resourceId, apiVersion, body) {
  az([
    "rest",
    "--method",
    "PUT",
    "--url",
    `https://management.azure.com${resourceId}?api-version=${apiVersion}`,
    "--body",
    JSON.stringify(body),
    "--output",
    "none",
  ]);
}

function ensureFrontDoorAccess() {
  az(appGatewayNsgRuleArgs());
  azurePut(frontDoorWafPolicyId(), "2022-05-01", renderFrontDoorWafPolicy());
  const endpointIds = Object.values(config.environments).map((env) =>
    az(
      [
        "afd",
        "endpoint",
        "show",
        ...frontDoorCommonArgs(),
        "--endpoint-name",
        env.frontDoorEndpoint,
        "--query",
        "id",
        "--output",
        "tsv",
      ],
      { capture: true },
    ),
  );
  azurePut(
    frontDoorSecurityPolicyId(),
    "2025-04-15",
    renderFrontDoorSecurityPolicy(endpointIds),
  );
  az([
    "afd",
    "security-policy",
    "wait",
    ...frontDoorCommonArgs(),
    "--security-policy-name",
    config.azure.frontDoorSecurityPolicy,
    "--updated",
    "--interval",
    "10",
    "--timeout",
    "600",
  ]);
}

function ensureFrontDoor(environment) {
  const env = config.environments[environment];
  const common = frontDoorCommonArgs();
  if (
    !az(
      [
        "afd",
        "origin-group",
        "list",
        ...common,
        "--query",
        `[?name=='${env.frontDoorOriginGroup}'].name | [0]`,
        "-o",
        "tsv",
      ],
      { capture: true },
    )
  ) {
    az(frontDoorOriginGroupCreateArgs(environment));
  }
  const origin = tryRun("az", [
    "afd",
    "origin",
    "show",
    ...common,
    "--origin-group-name",
    env.frontDoorOriginGroup,
    "--origin-name",
    env.frontDoorOrigin,
    "--output",
    "none",
  ]);
  if (origin.status !== 0) {
    az(frontDoorOriginCreateArgs(environment));
  }
  const route = tryRun("az", [
    "afd",
    "route",
    "show",
    ...common,
    "--endpoint-name",
    env.frontDoorEndpoint,
    "--route-name",
    "openhands-halo",
    "--output",
    "none",
  ]);
  if (route.status !== 0) {
    az([
      "afd",
      "route",
      "create",
      ...common,
      "--endpoint-name",
      env.frontDoorEndpoint,
      "--route-name",
      "openhands-halo",
      "--origin-group",
      env.frontDoorOriginGroup,
      "--supported-protocols",
      "Http",
      "Https",
      "--patterns-to-match",
      "/*",
      "--forwarding-protocol",
      "HttpOnly",
      "--https-redirect",
      "Enabled",
      "--link-to-default-domain",
      "Enabled",
      "--enabled-state",
      "Enabled",
      "--output",
      "none",
    ]);
  }
}

function bootstrapEnvironment(environment) {
  const env = config.environments[environment];
  const runtime = ensureIdentity(env.runtimeIdentity);
  ensureEntraApplication(environment);
  const vaultId = az(
    [
      "keyvault",
      "show",
      "--resource-group",
      config.azure.resourceGroup,
      "--name",
      config.azure.keyVaultName,
      "--query",
      "id",
      "--output",
      "tsv",
    ],
    { capture: true },
  );
  ensureRole({
    principalId: runtime.principalId,
    role: "Key Vault Secrets User",
    scope: vaultId,
  });
  const openAiScope = `/subscriptions/${config.azureOpenAI.subscriptionId}/resourceGroups/${config.azureOpenAI.resourceGroup}/providers/Microsoft.CognitiveServices/accounts/${config.azureOpenAI.accountName}`;
  ensureRole({
    principalId: runtime.principalId,
    role: "Cognitive Services OpenAI User",
    scope: openAiScope,
  });
  ensureFederatedCredential({
    identityName: env.runtimeIdentity,
    credentialName: env.federatedCredential,
    namespace: env.namespace,
    serviceAccount: env.serviceAccount,
  });
  ensureNamespaceAndServiceAccount(
    env.namespace,
    env.serviceAccount,
    runtime.clientId,
  );
  kubectl(["apply", "-f", "-"], {
    input: renderWindowsPagefileRbac(environment),
  });
  kubectl(["apply", "-f", "-"], {
    input: renderSecretProviderClass(environment, runtime.clientId),
  });
  const hindsightSecretProviderClass = renderHindsightSecretProviderClass(
    environment,
    runtime.clientId,
  );
  if (hindsightSecretProviderClass) {
    kubectl(["apply", "-f", "-"], { input: hindsightSecretProviderClass });
  }
  const hindsightBrokerSecretProviderClass =
    renderHindsightBrokerSecretProviderClass(environment, runtime.clientId);
  if (hindsightBrokerSecretProviderClass) {
    kubectl(["apply", "-f", "-"], {
      input: hindsightBrokerSecretProviderClass,
    });
  }
  kubectl(["apply", "-f", "-"], {
    input: renderConversationStorageClass(),
  });
  kubectl(["apply", "-f", "-"], {
    input: renderWorkspaceStorageClass(),
  });
  kubectl(["apply", "-f", "-"], {
    input: renderWorkspaceStorageClass("windows"),
  });
  kubectl(["apply", "-f", "-"], {
    input: renderConversationPvc(environment),
  });
  ensureFrontDoor(environment);
}

function ensureNatGatewayResources() {
  const network = config.network;
  const existingPublicIp = tryRun("az", [
    "network",
    "public-ip",
    "show",
    "--subscription",
    config.azure.subscriptionId,
    "--resource-group",
    config.azure.resourceGroup,
    "--name",
    network.publicIp,
    "--output",
    "json",
  ]);
  if (existingPublicIp.status !== 0) {
    az(natGatewayPublicIpCreateArgs());
  }
  const publicIp = JSON.parse(
    az(
      [
        "network",
        "public-ip",
        "show",
        "--subscription",
        config.azure.subscriptionId,
        "--resource-group",
        config.azure.resourceGroup,
        "--name",
        network.publicIp,
        "--output",
        "json",
      ],
      { capture: true },
    ),
  );
  validateNatGatewayPublicIp(publicIp);

  const natGateway = tryRun("az", [
    "network",
    "nat",
    "gateway",
    "show",
    "--subscription",
    config.azure.subscriptionId,
    "--resource-group",
    config.azure.resourceGroup,
    "--name",
    network.natGateway,
    "--output",
    "json",
  ]);
  if (natGateway.status !== 0) {
    az(natGatewayCreateArgs());
  } else {
    az([
      "network",
      "nat",
      "gateway",
      "update",
      "--subscription",
      config.azure.subscriptionId,
      "--resource-group",
      config.azure.resourceGroup,
      "--name",
      network.natGateway,
      "--public-ip-addresses",
      network.publicIp,
      "--idle-timeout",
      String(network.idleTimeoutMinutes),
      "--output",
      "none",
    ]);
  }
}

function ensureAksNatGateway() {
  ensureNatGatewayResources();
  const authorizedCidrs = JSON.parse(
    az(
      [
        "aks",
        "show",
        "--subscription",
        config.azure.subscriptionId,
        "--resource-group",
        config.azure.resourceGroup,
        "--name",
        config.azure.aksCluster,
        "--query",
        "apiServerAccessProfile.authorizedIpRanges",
        "--output",
        "json",
      ],
      { capture: true },
    ),
  );
  if (
    [...authorizedCidrs].sort().join(",") !==
    [...config.network.apiServerAuthorizedCidrs].sort().join(",")
  ) {
    az(aksApiServerAuthorizedIpUpdateArgs());
  }
  ensureFrontDoorAccess();
  for (const subnet of aksNatGatewaySubnets()) {
    az(natGatewaySubnetUpdateArgs(subnet));
  }
  const outboundType = az(
    [
      "aks",
      "show",
      "--subscription",
      config.azure.subscriptionId,
      "--resource-group",
      config.azure.resourceGroup,
      "--name",
      config.azure.aksCluster,
      "--query",
      "networkProfile.outboundType",
      "--output",
      "tsv",
    ],
    { capture: true },
  );
  if (outboundType !== "userAssignedNATGateway") {
    az(aksNatGatewayUpdateArgs());
  }
  az(blobPrivateDnsLinkUpdateArgs());
  ensurePrivateDnsOverrides();
}

function ensurePostgresNetwork() {
  const postgres = config.postgres;
  const subnet = tryRun("az", [
    "network",
    "vnet",
    "subnet",
    "show",
    "--resource-group",
    config.azure.resourceGroup,
    "--vnet-name",
    postgres.vnet,
    "--name",
    postgres.subnet,
    "--output",
    "json",
  ]);
  if (subnet.status !== 0) {
    az([
      "network",
      "vnet",
      "subnet",
      "create",
      "--resource-group",
      config.azure.resourceGroup,
      "--vnet-name",
      postgres.vnet,
      "--name",
      postgres.subnet,
      "--address-prefixes",
      postgres.subnetPrefix,
      "--delegations",
      "Microsoft.DBforPostgreSQL/flexibleServers",
      "--output",
      "none",
    ]);
  }
  const zone = tryRun("az", [
    "network",
    "private-dns",
    "zone",
    "show",
    "--resource-group",
    config.azure.resourceGroup,
    "--name",
    postgres.privateDnsZone,
    "--output",
    "json",
  ]);
  if (zone.status !== 0) {
    az([
      "network",
      "private-dns",
      "zone",
      "create",
      "--resource-group",
      config.azure.resourceGroup,
      "--name",
      postgres.privateDnsZone,
      "--output",
      "none",
    ]);
  }
  const link = tryRun("az", [
    "network",
    "private-dns",
    "link",
    "vnet",
    "show",
    "--resource-group",
    config.azure.resourceGroup,
    "--zone-name",
    postgres.privateDnsZone,
    "--name",
    postgres.privateDnsLink,
    "--output",
    "json",
  ]);
  if (link.status !== 0) {
    az([
      "network",
      "private-dns",
      "link",
      "vnet",
      "create",
      "--resource-group",
      config.azure.resourceGroup,
      "--zone-name",
      postgres.privateDnsZone,
      "--name",
      postgres.privateDnsLink,
      "--virtual-network",
      postgres.vnet,
      "--registration-enabled",
      "false",
      "--output",
      "none",
    ]);
  }
  return {
    subnetId: az(
      [
        "network",
        "vnet",
        "subnet",
        "show",
        "--resource-group",
        config.azure.resourceGroup,
        "--vnet-name",
        postgres.vnet,
        "--name",
        postgres.subnet,
        "--query",
        "id",
        "--output",
        "tsv",
      ],
      { capture: true },
    ),
    privateDnsZoneId: az(
      [
        "network",
        "private-dns",
        "zone",
        "show",
        "--resource-group",
        config.azure.resourceGroup,
        "--name",
        postgres.privateDnsZone,
        "--query",
        "id",
        "--output",
        "tsv",
      ],
      { capture: true },
    ),
  };
}

async function bootstrapPostgres() {
  const postgres = config.postgres;
  validateHindsightPostgresConfig();
  const bootstrapIdentity = ensureIdentity(config.identities.postgresBootstrap);
  ensureFederatedCredential({
    identityName: config.identities.postgresBootstrap,
    credentialName: postgres.bootstrapFederatedCredential,
    namespace: config.build.namespace,
    serviceAccount: postgres.bootstrapServiceAccount,
  });
  ensureNamespaceAndServiceAccount(
    config.build.namespace,
    postgres.bootstrapServiceAccount,
    bootstrapIdentity.clientId,
  );
  const vaultId = az(
    [
      "keyvault",
      "show",
      "--resource-group",
      config.azure.resourceGroup,
      "--name",
      config.azure.keyVaultName,
      "--query",
      "id",
      "--output",
      "tsv",
    ],
    { capture: true },
  );
  ensureRole({
    principalId: bootstrapIdentity.principalId,
    role: "Key Vault Secrets User",
    scope: vaultId,
  });
  kubectl(["apply", "-f", "-"], {
    input: renderPostgresBootstrapSecretProviderClass(
      bootstrapIdentity.clientId,
    ),
  });
  const network = ensurePostgresNetwork();
  const server = tryRun("az", [
    "postgres",
    "flexible-server",
    "show",
    "--resource-group",
    postgres.resourceGroup,
    "--name",
    postgres.serverName,
    "--output",
    "json",
  ]);
  if (server.status !== 0) {
    az(
      postgresServerCreateArgs(
        bootstrapIdentity,
        network.subnetId,
        network.privateDnsZoneId,
      ),
    );
    az(postgresServerAuthUpdateArgs());
  } else {
    az(postgresServerAuthUpdateArgs());
    const admin = az(
      [
        "postgres",
        "flexible-server",
        "microsoft-entra-admin",
        "list",
        "--resource-group",
        postgres.resourceGroup,
        "--server-name",
        postgres.serverName,
        "--query",
        `[?objectId=='${bootstrapIdentity.principalId}'].objectId | [0]`,
        "--output",
        "tsv",
      ],
      { capture: true },
    );
    if (!admin) {
      az([
        "postgres",
        "flexible-server",
        "microsoft-entra-admin",
        "create",
        "--resource-group",
        postgres.resourceGroup,
        "--server-name",
        postgres.serverName,
        "--display-name",
        bootstrapIdentity.name,
        "--object-id",
        bootstrapIdentity.principalId,
        "--type",
        "ServicePrincipal",
        "--output",
        "none",
      ]);
    }
  }
  const currentExtensions = az(
    [
      "postgres",
      "flexible-server",
      "parameter",
      "show",
      "--resource-group",
      postgres.resourceGroup,
      "--server-name",
      postgres.serverName,
      "--name",
      "azure.extensions",
      "--query",
      "value",
      "--output",
      "tsv",
    ],
    { capture: true },
  );
  az([
    "postgres",
    "flexible-server",
    "parameter",
    "set",
    "--resource-group",
    postgres.resourceGroup,
    "--server-name",
    postgres.serverName,
    "--name",
    "azure.extensions",
    "--value",
    postgresExtensionsParameterValue(currentExtensions),
    "--output",
    "none",
  ]);
  const databases = Object.values(config.environments).flatMap((env) => [
    env.database,
    ...(env.hindsight?.enabled ? [env.hindsight.database] : []),
  ]);
  for (const databaseName of databases) {
    const database = az(
      [
        "postgres",
        "flexible-server",
        "db",
        "list",
        "--resource-group",
        postgres.resourceGroup,
        "--server-name",
        postgres.serverName,
        "--query",
        `[?name=='${databaseName}'].name | [0]`,
        "--output",
        "tsv",
      ],
      { capture: true },
    );
    if (!database) {
      az([
        "postgres",
        "flexible-server",
        "db",
        "create",
        "--resource-group",
        postgres.resourceGroup,
        "--server-name",
        postgres.serverName,
        "--name",
        databaseName,
        "--output",
        "none",
      ]);
    }
  }
  const job = "halo-postgres-bootstrap";
  kubectl([
    "-n",
    config.build.namespace,
    "delete",
    "job",
    job,
    "--ignore-not-found",
    "--wait=true",
  ]);
  kubectl(["apply", "-f", "-"], {
    input: renderPostgresBootstrapJob({
      candidate: identity(config.environments.candidate.runtimeIdentity),
      primary: identity(config.environments.primary.runtimeIdentity),
    }),
  });
  await waitForJob(config.build.namespace, job, 10 * 60 * 1000);
}

async function bootstrap() {
  ensureAksNatGateway();
  bootstrapBuild();
  ensureRuntimeNodePool();
  ensureWindowsRuntimeNodePool();
  ensureAgentSandbox();
  ensureFrontDoorAccess();
  validateAzureOpenAi();
  bootstrapEnvironment("candidate");
  bootstrapEnvironment("primary");
  await bootstrapPostgres();
}

function arcGithubAppCredentials(args) {
  const appId = option(args, "--github-app-id");
  const installationId = option(args, "--github-app-installation-id");
  const privateKeyPath = option(args, "--github-app-private-key");
  const supplied = [appId, installationId, privateKeyPath].filter(Boolean);
  let value;
  if (supplied.length > 0 && supplied.length !== 3) {
    throw new Error(
      "GitHub App setup requires --github-app-id, --github-app-installation-id, and --github-app-private-key together",
    );
  }
  if (supplied.length === 3) {
    value = JSON.stringify({
      github_app_id: appId,
      github_app_installation_id: installationId,
      github_app_private_key: readFileSync(resolve(privateKeyPath), "utf8"),
    });
    const secretPath = join(
      tmpdir(),
      `openhands-halo-github-app-${process.pid}.json`,
    );
    writeFileSync(secretPath, value, { encoding: "utf8", mode: 0o600 });
    try {
      az([
        "keyvault",
        "secret",
        "set",
        "--vault-name",
        config.azure.keyVaultName,
        "--name",
        config.ci.githubAppKeyVaultSecret,
        "--file",
        secretPath,
        "--output",
        "none",
      ]);
    } finally {
      unlinkSync(secretPath);
    }
  } else {
    value = az(
      [
        "keyvault",
        "secret",
        "show",
        "--vault-name",
        config.azure.keyVaultName,
        "--name",
        config.ci.githubAppKeyVaultSecret,
        "--query",
        "value",
        "--output",
        "tsv",
      ],
      { capture: true },
    );
  }
  const credentials = JSON.parse(value);
  for (const key of [
    "github_app_id",
    "github_app_installation_id",
    "github_app_private_key",
  ]) {
    if (!credentials[key]) {
      throw new Error(`GitHub App credential is missing ${key}`);
    }
  }
  return credentials;
}

function applyArcGithubAppSecret(credentials) {
  const data = Object.fromEntries(
    Object.entries(credentials).map(([key, value]) => [
      key,
      Buffer.from(String(value), "utf8").toString("base64"),
    ]),
  );
  kubectl(["apply", "-f", "-"], {
    input: JSON.stringify({
      apiVersion: "v1",
      kind: "Secret",
      metadata: {
        name: config.ci.githubAppSecret,
        namespace: config.ci.runnerNamespace,
      },
      type: "Opaque",
      data,
    }),
  });
}

function bootstrapCi(args) {
  bootstrapBuild();
  kubectl(["apply", "-f", "-"], { input: renderArcRunnerRbac() });
  applyArcGithubAppSecret(arcGithubAppCredentials(args));
  const controllerValuesPath = join(
    tmpdir(),
    `openhands-halo-arc-controller-${process.pid}.yaml`,
  );
  const runnerValuesPath = join(
    tmpdir(),
    `openhands-halo-arc-runner-${process.pid}.yaml`,
  );
  writeFileSync(controllerValuesPath, renderArcControllerValues(), "utf8");
  writeFileSync(runnerValuesPath, renderArcRunnerValues(), "utf8");
  try {
    helm([
      "upgrade",
      "--install",
      config.ci.controllerRelease,
      "oci://ghcr.io/actions/actions-runner-controller-charts/gha-runner-scale-set-controller",
      "--version",
      config.ci.arcVersion,
      "--namespace",
      config.ci.controllerNamespace,
      "--values",
      controllerValuesPath,
      "--wait",
      "--timeout",
      "10m",
    ]);
    helm([
      "upgrade",
      "--install",
      config.ci.runnerRelease,
      "oci://ghcr.io/actions/actions-runner-controller-charts/gha-runner-scale-set",
      "--version",
      config.ci.arcVersion,
      "--namespace",
      config.ci.runnerNamespace,
      "--values",
      runnerValuesPath,
      "--wait",
      "--timeout",
      "10m",
    ]);
  } finally {
    unlinkSync(controllerValuesPath);
    unlinkSync(runnerValuesPath);
  }
}

function printResult(result) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

async function waitForJob(namespace, job, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = JSON.parse(
      kubectl(["-n", namespace, "get", "job", job, "-o", "json"], {
        capture: true,
      }),
    );
    const conditions = state.status?.conditions ?? [];
    if (
      conditions.some(
        (condition) =>
          condition.type === "Complete" && condition.status === "True",
      )
    ) {
      return;
    }
    if (
      conditions.some(
        (condition) =>
          condition.type === "Failed" && condition.status === "True",
      )
    ) {
      throw new Error(
        `Build Job ${job} failed: ${conditions
          .filter((condition) => condition.status === "True")
          .map((condition) => `${condition.reason}: ${condition.message}`)
          .join("; ")}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  throw new Error(`Timed out waiting for build Job ${job}`);
}

async function build(args) {
  const definitions = sourceDefinitions();
  const sources = {
    openhands: {
      ...definitions.openhands,
      commit: normalizeCommit(option(args, "--openhands-sha"), "OpenHands SHA"),
    },
    agentServer: {
      ...definitions.agentServer,
      commit: normalizeCommit(
        option(args, "--agent-server-sha"),
        "Agent Server SHA",
      ),
    },
    sandboxServer: {
      ...definitions.sandboxServer,
      commit: normalizeCommit(
        option(args, "--sandbox-server-sha"),
        "Sandbox Server SHA",
      ),
    },
  };
  const commit = sources.openhands.commit;
  const short = commit.slice(0, 9);
  const job = `halo-build-${short}`;
  kubectl([
    "-n",
    config.build.namespace,
    "delete",
    "job",
    job,
    "--ignore-not-found",
    "--wait=true",
  ]);
  kubectl(["apply", "-f", "-"], {
    input: renderBuildJob({
      commit,
      agentServerCommit: sources.agentServer.commit,
      sandboxServerCommit: sources.sandboxServer.commit,
    }),
  });
  try {
    await waitForJob(config.build.namespace, job, 90 * 60 * 1000);
  } catch (error) {
    printResult(
      tryRun("kubectl", [
        "-n",
        config.build.namespace,
        "describe",
        `job/${job}`,
      ]),
    );
    printResult(
      tryRun("kubectl", [
        "-n",
        config.build.namespace,
        "logs",
        `job/${job}`,
        "--all-containers=true",
        "--prefix",
        "--tail=300",
      ]),
    );
    throw error;
  }
  const pods = JSON.parse(
    kubectl(
      [
        "-n",
        config.build.namespace,
        "get",
        "pods",
        "-l",
        `job-name=${job}`,
        "-o",
        "json",
      ],
      { capture: true },
    ),
  );
  const digests = buildDigestsFromPodList(pods);
  console.log(`CANVAS_IMAGE_DIGEST=${digests.canvas}`);
  console.log(`AGENT_SERVER_IMAGE_DIGEST=${digests.agentServer}`);
  console.log(`SANDBOX_SERVER_IMAGE_DIGEST=${digests.sandboxServer}`);
  console.log(`SANDBOX_RUNTIME_IMAGE_DIGEST=${digests.sandboxRuntime}`);
  printResolvedSources(sources);
  kubectl(["-n", config.build.namespace, "delete", "job", job, "--wait=false"]);
}

async function waitForReady(environment) {
  const env = config.environments[environment];
  const readyPath = `/api/v1/namespaces/${env.namespace}/services/http:openhands-halo:8000/proxy/ready`;
  const deadline = Date.now() + 15 * 60 * 1000;
  let lastError = "not attempted";
  while (Date.now() < deadline) {
    try {
      const response = JSON.parse(
        kubectl(["get", "--raw", readyPath], { capture: true }),
      );
      if (response.status === "ready") return;
      lastError = `unexpected response: ${JSON.stringify(response)}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  throw new Error(
    `Timed out waiting for ${env.namespace}/openhands-halo readiness: ${lastError}`,
  );
}

async function waitForSecretKey(namespace, secret, key) {
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    const result = tryRun("kubectl", [
      "-n",
      namespace,
      "get",
      "secret",
      secret,
      "-o",
      `jsonpath={.data.${key}}`,
    ]);
    if (result.status === 0 && result.stdout.trim()) return;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(
    `Timed out waiting for ${namespace}/${secret} key ${key} to synchronize`,
  );
}

function runtimeClientId(environment) {
  const env = config.environments[environment];
  const serviceAccount = JSON.parse(
    kubectl(
      [
        "-n",
        env.namespace,
        "get",
        "serviceaccount",
        env.serviceAccount,
        "-o",
        "json",
      ],
      { capture: true },
    ),
  );
  const clientId =
    serviceAccount.metadata?.annotations?.["azure.workload.identity/client-id"];
  if (!clientId) {
    throw new Error(
      `ServiceAccount ${env.namespace}/${env.serviceAccount} is missing its Azure Workload Identity client id; run halo bootstrap`,
    );
  }
  return clientId;
}

async function deploy(
  environment,
  canvasDigest,
  agentServerDigest,
  sandboxServerDigest,
  sandboxRuntimeDigest,
  windowsRuntimeDigest,
) {
  const env = config.environments[environment];
  const clientId = runtimeClientId(environment);
  kubectl(["apply", "-f", "-"], {
    input: renderSecretProviderClass(environment, clientId),
  });
  const hindsightSecretProviderClass = renderHindsightSecretProviderClass(
    environment,
    clientId,
  );
  if (hindsightSecretProviderClass) {
    kubectl(["apply", "-f", "-"], { input: hindsightSecretProviderClass });
  }
  const hindsightBrokerSecretProviderClass =
    renderHindsightBrokerSecretProviderClass(environment, clientId);
  if (hindsightBrokerSecretProviderClass) {
    kubectl(["apply", "-f", "-"], {
      input: hindsightBrokerSecretProviderClass,
    });
  }
  const rbacBootstrapSecretProviderClass =
    renderRbacBootstrapSecretProviderClass(environment, clientId);
  if (rbacBootstrapSecretProviderClass) {
    kubectl(["apply", "-f", "-"], {
      input: rbacBootstrapSecretProviderClass,
    });
  }
  kubectl([
    "-n",
    env.namespace,
    "delete",
    "secret",
    "openhands-halo-secrets",
    "--ignore-not-found",
  ]);
  kubectl([
    "-n",
    env.namespace,
    "delete",
    "pod",
    "-l",
    "app.kubernetes.io/name=agent-canvas",
    "--ignore-not-found",
    "--wait=false",
  ]);
  const requiredSecretKeys = ["trustedIdentityAssertion", "jwtSecret"];
  if (
    env.githubApp.slug &&
    env.githubApp.secrets.clientId &&
    env.githubApp.secrets.clientSecret
  ) {
    requiredSecretKeys.push("githubAppClientId", "githubAppClientSecret");
  }
  for (const key of requiredSecretKeys) {
    await waitForSecretKey(env.namespace, "openhands-halo-secrets", key);
  }
  kubectl(["apply", "-f", "-"], {
    input: renderSandboxSpecBootstrapConfigMap(
      environment,
      sandboxRuntimeDigest,
      windowsRuntimeDigest,
    ),
  });
  kubectl(["apply", "-f", "-"], {
    input: renderAgentSandboxResources(
      environment,
      sandboxRuntimeDigest,
      windowsRuntimeDigest,
    ),
  });
  const valuesPath = join(
    tmpdir(),
    `openhands-halo-${environment}-${process.pid}.yaml`,
  );
  writeFileSync(
    valuesPath,
    renderHelmValues(environment, canvasDigest, clientId),
    "utf8",
  );
  try {
    helm([
      "upgrade",
      "--install",
      env.release,
      join("helm", "agent-canvas"),
      "--namespace",
      env.namespace,
      "--values",
      valuesPath,
      "--wait",
      "--timeout",
      "15m",
    ]);
  } finally {
    unlinkSync(valuesPath);
  }
  kubectl([
    "-n",
    env.namespace,
    "rollout",
    "status",
    "statefulset/openhands-halo",
    "--timeout=15m",
  ]);
  const hindsightResources = renderHindsightResources(environment);
  if (hindsightResources) {
    kubectl(["apply", "-f", "-"], { input: hindsightResources });
    const hindsightRollout = tryRun("kubectl", [
      "-n",
      env.namespace,
      "rollout",
      "status",
      `deployment/${config.hindsight.serviceName}`,
      "--timeout=15m",
    ]);
    if (hindsightRollout.status !== 0) {
      console.warn(
        `Optional Hindsight rollout is not ready; continuing fail-open: ${hindsightRollout.stderr.trim() || hindsightRollout.stdout.trim()}`,
      );
    }
  } else {
    for (const kind of ["deployment", "service", "networkpolicy"]) {
      kubectl([
        "-n",
        env.namespace,
        "delete",
        kind,
        config.hindsight.serviceName,
        "--ignore-not-found",
        "--wait=false",
      ]);
    }
  }
  kubectl(["apply", "-f", "-"], {
    input: renderSandboxServerResources(
      environment,
      sandboxServerDigest,
      sandboxRuntimeDigest,
      agentServerDigest,
      clientId,
      windowsRuntimeDigest,
    ),
  });
  kubectl([
    "-n",
    env.namespace,
    "rollout",
    "status",
    `deployment/${config.sandboxServer.serviceName}`,
    "--timeout=15m",
  ]);
  removeLegacyWorkspaceRuntimeRbac(environment);
  await waitForReady(environment);
  console.log(
    `${environment.toUpperCase()}_CANVAS_IMAGE=${imageReference(config.azure.acrLoginServer, config.build.repository, canvasDigest)}`,
  );
  console.log(
    `${environment.toUpperCase()}_AGENT_SERVER_IMAGE=${imageReference(config.azure.acrLoginServer, config.build.agentServerRepository, agentServerDigest)}`,
  );
  console.log(
    `${environment.toUpperCase()}_SANDBOX_SERVER_IMAGE=${imageReference(config.azure.acrLoginServer, config.build.sandboxServerRepository, sandboxServerDigest)}`,
  );
  console.log(
    `${environment.toUpperCase()}_SANDBOX_RUNTIME_IMAGE=${imageReference(config.azure.acrLoginServer, config.build.sandboxRuntimeRepository, sandboxRuntimeDigest)}`,
  );
  console.log(
    `${environment.toUpperCase()}_WINDOWS_RUNTIME_IMAGE=${externalImageReference(config.windowsRuntime.imageRepository, windowsRuntimeDigest)}`,
  );
  if (env.hindsight?.enabled) {
    console.log(
      `${environment.toUpperCase()}_HINDSIGHT_IMAGE=${externalImageReference(config.hindsight.image.repository, config.hindsight.image.digest)}`,
    );
  }
}

export function windowsRuntimeTemplateName() {
  const windowsProfile = config.agentSandbox.profileSeeds.find(
    (profile) => profile.enabled && profile.os === "windows",
  );
  if (!windowsProfile) {
    throw new Error("No enabled Windows execution profile is configured");
  }
  return windowsProfile.template;
}

export function windowsRuntimeImageFromKubectlResult(
  result,
  /** @type {string | null} */
  fallbackWindowsRuntimeDigest = null,
) {
  if (result.status === 0) return result.stdout.trim();
  if (
    fallbackWindowsRuntimeDigest &&
    /\bnotfound\b|\bnot found\b/i.test(result.stderr)
  ) {
    return externalImageReference(
      config.windowsRuntime.imageRepository,
      fallbackWindowsRuntimeDigest,
    );
  }
  throw new Error(
    `Could not read the deployed Windows runtime image: ${result.stderr.trim() || `kubectl exited ${result.status}`}`,
  );
}

function environmentDigests(
  environment,
  { fallbackWindowsRuntimeDigest = null } = {},
) {
  const env = config.environments[environment];
  const canvasImage = kubectl(
    [
      "-n",
      env.namespace,
      "get",
      "statefulset",
      "openhands-halo",
      "-o",
      "jsonpath={.spec.template.spec.containers[0].image}",
    ],
    { capture: true },
  );
  const sandboxServerImage = kubectl(
    [
      "-n",
      env.namespace,
      "get",
      "deployment",
      config.sandboxServer.serviceName,
      "-o",
      "jsonpath={.spec.template.spec.containers[0].image}",
    ],
    { capture: true },
  );
  const agentServerImage = kubectl(
    [
      "-n",
      env.namespace,
      "get",
      "sandboxtemplate",
      config.agentSandbox.template,
      "-o",
      "jsonpath={.spec.podTemplate.spec.containers[0].image}",
    ],
    { capture: true },
  );
  const sandboxRuntimeImage = kubectl(
    [
      "-n",
      env.namespace,
      "get",
      "deployment",
      config.sandboxServer.serviceName,
      "-o",
      'jsonpath={.spec.template.spec.containers[0].env[?(@.name=="AGENT_SERVER_IMAGE")].value}',
    ],
    { capture: true },
  );
  const windowsRuntimeImage = windowsRuntimeImageFromKubectlResult(
    tryRun("kubectl", [
      "-n",
      env.namespace,
      "get",
      "sandboxtemplate",
      windowsRuntimeTemplateName(),
      "-o",
      "jsonpath={.spec.podTemplate.spec.containers[0].image}",
    ]),
    fallbackWindowsRuntimeDigest,
  );
  const canvasPrefix = `${config.azure.acrLoginServer}/${config.build.repository}@`;
  const agentServerPrefix = `${config.azure.acrLoginServer}/${config.build.agentServerRepository}@`;
  const sandboxServerPrefix = `${config.azure.acrLoginServer}/${config.build.sandboxServerRepository}@`;
  const sandboxRuntimePrefix = `${config.azure.acrLoginServer}/${config.build.sandboxRuntimeRepository}@`;
  const windowsRuntimePrefix = `${config.windowsRuntime.imageRepository}@`;
  if (!canvasImage.startsWith(canvasPrefix)) {
    throw new Error(
      `${environment} Canvas is not deployed by immutable digest: ${canvasImage}`,
    );
  }
  if (!sandboxServerImage.startsWith(sandboxServerPrefix)) {
    throw new Error(
      `${environment} Sandbox Server is not deployed by immutable digest: ${sandboxServerImage}`,
    );
  }
  if (!agentServerImage.startsWith(agentServerPrefix)) {
    throw new Error(
      `${environment} Agent Server is not deployed by immutable digest: ${agentServerImage}`,
    );
  }
  if (!sandboxRuntimeImage.startsWith(sandboxRuntimePrefix)) {
    throw new Error(
      `${environment} Sandbox Runtime is not deployed by immutable digest: ${sandboxRuntimeImage}`,
    );
  }
  if (!windowsRuntimeImage.startsWith(windowsRuntimePrefix)) {
    throw new Error(
      `${environment} Windows runtime is not deployed by immutable digest: ${windowsRuntimeImage}`,
    );
  }
  return {
    canvas: normalizeDigest(canvasImage.slice(canvasPrefix.length)),
    agentServer: normalizeDigest(
      agentServerImage.slice(agentServerPrefix.length),
    ),
    sandboxServer: normalizeDigest(
      sandboxServerImage.slice(sandboxServerPrefix.length),
    ),
    sandboxRuntime: normalizeDigest(
      sandboxRuntimeImage.slice(sandboxRuntimePrefix.length),
    ),
    windowsRuntime: normalizeDigest(
      windowsRuntimeImage.slice(windowsRuntimePrefix.length),
    ),
  };
}

function savePrimaryRollbackTarget(digests) {
  const env = config.environments.primary;
  const yaml = kubectl(
    [
      "-n",
      env.namespace,
      "create",
      "configmap",
      "openhands-halo-rollback",
      `--from-literal=release=${JSON.stringify(digests)}`,
      "--dry-run=client",
      "-o",
      "yaml",
    ],
    { capture: true },
  );
  kubectl(["apply", "-f", "-"], { input: yaml });
}

async function promote(args) {
  const env = config.environments.candidate;
  kubectl([
    "-n",
    env.namespace,
    "rollout",
    "status",
    "statefulset/openhands-halo",
    "--timeout=5m",
  ]);
  await waitForReady("candidate");
  const digests = environmentDigests("candidate");
  const expectedCanvasDigest = option(args, "--canvas-digest");
  const expectedAgentServerDigest = option(args, "--agent-server-digest");
  const expectedSandboxServerDigest = option(args, "--sandbox-server-digest");
  const expectedSandboxRuntimeDigest = option(args, "--sandbox-runtime-digest");
  const expectedWindowsRuntimeDigest = option(args, "--windows-runtime-digest");
  if (
    expectedCanvasDigest &&
    normalizeDigest(expectedCanvasDigest) !== digests.canvas
  ) {
    throw new Error(
      `Candidate Canvas digest changed while promotion awaited approval: expected ${expectedCanvasDigest}, found ${digests.canvas}`,
    );
  }
  if (
    expectedAgentServerDigest &&
    normalizeDigest(expectedAgentServerDigest) !== digests.agentServer
  ) {
    throw new Error(
      `Candidate Agent Server digest changed while promotion awaited approval: expected ${expectedAgentServerDigest}, found ${digests.agentServer}`,
    );
  }
  if (
    expectedSandboxServerDigest &&
    normalizeDigest(expectedSandboxServerDigest) !== digests.sandboxServer
  ) {
    throw new Error(
      `Candidate Sandbox Server digest changed while promotion awaited approval: expected ${expectedSandboxServerDigest}, found ${digests.sandboxServer}`,
    );
  }
  if (
    expectedSandboxRuntimeDigest &&
    normalizeDigest(expectedSandboxRuntimeDigest) !== digests.sandboxRuntime
  ) {
    throw new Error(
      `Candidate Sandbox Runtime digest changed while promotion awaited approval: expected ${expectedSandboxRuntimeDigest}, found ${digests.sandboxRuntime}`,
    );
  }
  if (
    expectedWindowsRuntimeDigest &&
    normalizeDigest(expectedWindowsRuntimeDigest) !== digests.windowsRuntime
  ) {
    throw new Error(
      `Candidate Windows runtime digest changed while promotion awaited approval: expected ${expectedWindowsRuntimeDigest}, found ${digests.windowsRuntime}`,
    );
  }
  console.log(
    `Promoting candidate digests ${digests.canvas}, ${digests.agentServer}, ${digests.sandboxServer}, ${digests.sandboxRuntime}, and ${digests.windowsRuntime}`,
  );
  savePrimaryRollbackTarget(
    environmentDigests("primary", {
      // The first Windows promotion snapshots a primary deployment that has no
      // Windows template yet. There is no older Windows image to restore, so
      // retain the verified candidate digest while rolling back every
      // pre-existing primary component.
      fallbackWindowsRuntimeDigest: digests.windowsRuntime,
    }),
  );
  await deploy(
    "primary",
    digests.canvas,
    digests.agentServer,
    digests.sandboxServer,
    digests.sandboxRuntime,
    digests.windowsRuntime,
  );
}

async function rollbackPrimary() {
  const env = config.environments.primary;
  const release = kubectl(
    [
      "-n",
      env.namespace,
      "get",
      "configmap",
      "openhands-halo-rollback",
      "-o",
      "jsonpath={.data.release}",
    ],
    { capture: true },
  );
  const digests = parseRollbackDigests(release);
  await deploy(
    "primary",
    digests.canvas,
    digests.agentServer,
    digests.sandboxServer,
    digests.sandboxRuntime,
    digests.windowsRuntime,
  );
}

export function parseRollbackDigests(release) {
  try {
    const digests = JSON.parse(release);
    for (const key of [
      "canvas",
      "agentServer",
      "sandboxServer",
      "sandboxRuntime",
      "windowsRuntime",
    ]) {
      digests[key] = normalizeDigest(digests[key]);
    }
    return digests;
  } catch {
    throw new Error(
      "Primary rollback metadata is missing or invalid; no deployment was changed",
    );
  }
}

function status() {
  for (const [name, env] of Object.entries(config.environments)) {
    const result = tryRun("kubectl", [
      "-n",
      env.namespace,
      "get",
      "statefulset",
      "openhands-halo",
      "-o",
      "jsonpath={.spec.template.spec.containers[0].image}",
    ]);
    console.log(
      `${name}: ${result.status === 0 ? result.stdout.trim() : "not deployed"}`,
    );
    if (env.hindsight?.enabled) {
      const hindsight = tryRun("kubectl", [
        "-n",
        env.namespace,
        "get",
        "deployment",
        config.hindsight.serviceName,
        "-o",
        "jsonpath={.spec.template.spec.containers[0].image}",
      ]);
      console.log(
        `${name} hindsight: ${hindsight.status === 0 ? hindsight.stdout.trim() : "not deployed"}`,
      );
    }
  }
}

function usage() {
  console.log(`Usage:
  npm run halo -- bootstrap
  npm run halo -- bootstrap-network
  npm run halo -- bootstrap-ci [--github-app-id <id> --github-app-installation-id <id> --github-app-private-key <path>]
  npm run halo -- resolve-sources
  npm run halo -- build --openhands-sha <sha> --agent-server-sha <sha> --sandbox-server-sha <sha>
  npm run halo -- preflight-windows --windows-runtime-digest sha256:<digest>
  npm run halo -- deploy-candidate --canvas-digest sha256:<digest> --agent-server-digest sha256:<digest> --sandbox-server-digest sha256:<digest> --sandbox-runtime-digest sha256:<digest> --windows-runtime-digest sha256:<digest>
  npm run halo -- promote [--canvas-digest sha256:<candidate-digest> --agent-server-digest sha256:<candidate-digest> --sandbox-server-digest sha256:<candidate-digest> --sandbox-runtime-digest sha256:<candidate-digest> --windows-runtime-digest sha256:<candidate-digest>]
  npm run halo -- rollback-primary
  npm run halo -- status`);
}

async function main(args = process.argv.slice(2)) {
  const [command] = args;
  switch (command) {
    case "bootstrap":
      await bootstrap();
      break;
    case "bootstrap-network":
      ensureAksNatGateway();
      break;
    case "bootstrap-ci":
      bootstrapCi(args.slice(1));
      break;
    case "resolve-sources":
      printResolvedSources(resolveSourceHeads());
      break;
    case "build":
      await build(args.slice(1));
      break;
    case "preflight-windows":
      await preflightWindowsRuntime(
        "candidate",
        normalizeDigest(
          option(
            args,
            "--windows-runtime-digest",
            process.env.HALO_WINDOWS_RUNTIME_DIGEST,
          ),
        ),
      );
      break;
    case "deploy-candidate":
      await deploy(
        "candidate",
        normalizeDigest(option(args, "--canvas-digest")),
        normalizeDigest(option(args, "--agent-server-digest")),
        normalizeDigest(option(args, "--sandbox-server-digest")),
        normalizeDigest(option(args, "--sandbox-runtime-digest")),
        normalizeDigest(
          option(
            args,
            "--windows-runtime-digest",
            process.env.HALO_WINDOWS_RUNTIME_DIGEST,
          ),
        ),
      );
      break;
    case "promote":
      await promote(args.slice(1));
      break;
    case "rollback-primary":
      await rollbackPrimary();
      break;
    case "status":
      status();
      break;
    default:
      usage();
      process.exitCode = command ? 1 : 0;
  }
}

const isMain =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
