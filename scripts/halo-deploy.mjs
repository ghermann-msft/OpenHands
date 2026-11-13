import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
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

function resolveCommit(ref) {
  return run("git", ["rev-parse", `${ref}^{commit}`], { capture: true });
}

function verifyCommitIsPushed(commit) {
  const remoteCommit = run(
    "git",
    [
      "ls-remote",
      config.source.repository,
      `refs/heads/${config.source.branch}`,
    ],
    { capture: true },
  ).split(/\s+/)[0];
  if (remoteCommit !== commit) {
    throw new Error(
      `${commit} is not the head of ${config.source.branch}; push the branch before building`,
    );
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
  if (mismatches.length > 0) {
    throw new Error(
      `AKS node pool ${build.nodePool} does not match the Halo build contract: ${mismatches.join(", ")}`,
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

export function renderBuildJob({ commit }) {
  const short = commit.slice(0, 9);
  const agentServerShort = config.source.agentServerSdkRef.slice(0, 9);
  const sandboxShort = config.source.sandboxServerRef.slice(0, 9);
  const build = config.build;
  const image = `${config.azure.acrLoginServer}/${build.repository}:${short}`;
  const cache = `${config.azure.acrLoginServer}/${build.repository}:${build.cacheTag}`;
  const agentServerImage = `${config.azure.acrLoginServer}/${build.agentServerRepository}:${agentServerShort}`;
  const agentServerCache = `${config.azure.acrLoginServer}/${build.agentServerRepository}:${build.agentServerCacheTag}`;
  const sandboxImage = `${config.azure.acrLoginServer}/${build.sandboxServerRepository}:${sandboxShort}`;
  const sandboxCache = `${config.azure.acrLoginServer}/${build.sandboxServerRepository}:${build.sandboxServerCacheTag}`;
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
              git checkout --detach ${config.source.sandboxServerRef}
              test "$(git rev-parse HEAD)" = "${config.source.sandboxServerRef}"
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
              git checkout --detach ${config.source.agentServerSdkRef}
              test "$(git rev-parse HEAD)" = "${config.source.agentServerSdkRef}"
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
              agent_server_metadata=/tmp/agent-server-build-metadata.json
              sandbox_metadata=/tmp/sandbox-build-metadata.json
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
              buildctl --addr unix:///run/buildkit/buildkitd.sock build \\
                --frontend dockerfile.v0 \\
                --local context=/workspace \\
                --local dockerfile=/workspace \\
                --opt filename=docker/Dockerfile \\
                --opt platform=linux/amd64 \\
                --opt build-arg:AGENT_SERVER_IMAGE=${defaults.images.agentServer}:${defaults.versions.agentServer}-python \\
                --opt build-arg:AGENT_SERVER_VERSION=${defaults.versions.agentServer} \\
                --opt build-arg:AGENT_SERVER_SDK_GIT_REPOSITORY=${config.source.agentServerSdkRepository} \\
                --opt build-arg:AGENT_SERVER_SDK_GIT_REF=${config.source.agentServerSdkRef} \\
                --opt build-arg:AUTOMATION_VERSION=${defaults.versions.automation} \\
                --opt build-arg:VITE_BASE_PATH=${defaults.paths.canvasBasePath} \\
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
              buildctl --addr unix:///run/buildkit/buildkitd.sock build \\
                --frontend dockerfile.v0 \\
                --local context=/sandbox-server \\
                --local dockerfile=/sandbox-server \\
                --opt filename=containers/app/Dockerfile \\
                --opt target=openhands-sandbox-server \\
                --opt platform=linux/amd64 \\
                --opt build-arg:OPENHANDS_BUILD_VERSION=halo-${sandboxShort} \\
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
              printf '{"canvas":"%s","agentServer":"%s","sandboxServer":"%s"}' "$canvas_digest" "$agent_server_digest" "$sandbox_digest" > /dev/termination-log
              printf 'CANVAS_IMAGE_DIGEST=%s\\n' "$canvas_digest"
              printf 'AGENT_SERVER_IMAGE_DIGEST=%s\\n' "$agent_server_digest"
              printf 'SANDBOX_SERVER_IMAGE_DIGEST=%s\\n' "$sandbox_digest"
          env:
            - name: DOCKER_CONFIG
              value: /docker
          securityContext:
            privileged: true
          resources:
            requests:
              cpu: "2"
              memory: 4Gi
              ephemeral-storage: 20Gi
            limits:
              cpu: "4"
              memory: 14Gi
              ephemeral-storage: 60Gi
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
      };
    } catch {
      // Check other pods before reporting the missing build result.
    }
  }
  throw new Error("Build Job did not publish immutable image digests");
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
    resources: ["pods"]
    verbs: ["get"]
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
  const builder = identity(config.identities.builder);
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
  ];
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

export function renderHelmValues(environment, digest, runtimeClientId) {
  const env = config.environments[environment];
  normalizeDigest(digest);
  const image = imageReference(
    config.azure.acrLoginServer,
    config.build.repository,
    digest,
  );
  return `fullnameOverride: openhands-halo
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

export function renderSandboxServerResources(
  environment,
  digest,
  runtimeClientId,
) {
  const env = config.environments[environment];
  const sandbox = config.sandboxServer;
  const image = imageReference(
    config.azure.acrLoginServer,
    config.build.sandboxServerRepository,
    digest,
  );
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
            - name: SERVE_FRONTEND
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
            - name: HIDE_LLM_SETTINGS
              value: "true"
            - name: OH_ALLOW_USER_LLM_CONFIGURATION
              value: "false"
            - name: OH_TRUSTED_IDENTITY_ASSERTION_SECRET
              valueFrom:
                secretKeyRef:
                  name: openhands-halo-secrets
                  key: trustedIdentityAssertion
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
            - name: OH_SANDBOX_KIND
              value: openhands.app_server.sandbox.kubernetes_sandbox_service.KubernetesSandboxServiceInjector
            - name: OH_SANDBOX_SPEC_KIND
              value: openhands.app_server.sandbox.kubernetes_sandbox_spec_service.KubernetesSandboxSpecServiceInjector
            - name: OH_SANDBOX_NAMESPACE
              value: ${env.namespace}
            - name: OH_SANDBOX_WARM_POOL
              value: ${config.agentSandbox.warmPool}
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
          readinessProbe:
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
---
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

export function renderAgentSandboxResources(environment, agentServerDigest) {
  const env = config.environments[environment];
  const agentSandbox = config.agentSandbox;
  const agentServerImage = imageReference(
    config.azure.acrLoginServer,
    config.build.agentServerRepository,
    agentServerDigest,
  );
  return `apiVersion: extensions.agents.x-k8s.io/v1beta1
kind: SandboxTemplate
metadata:
  name: ${agentSandbox.template}
  namespace: ${env.namespace}
spec:
  envVarsInjectionPolicy: Allowed
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
            port: 443
  volumeClaimTemplates:
    - metadata:
        name: workspace
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: ${config.workspaceStorage.storageClass}
        resources:
          requests:
            storage: ${config.workspaceStorage.size}
  podTemplate:
    metadata:
      labels:
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
      securityContext:
        runAsUser: 10001
        runAsGroup: 10001
        fsGroup: 10001
      containers:
        - name: agent-server
          image: ${agentServerImage}
          args: ["--host", "0.0.0.0", "--port", "8000"]
          workingDir: /workspace
          ports:
            - containerPort: 8000
              name: agent-server
            - containerPort: 8001
              name: vscode
          readinessProbe:
            httpGet:
              path: /health
              port: 8000
            initialDelaySeconds: 3
            periodSeconds: 3
            failureThreshold: 60
          resources:
            requests:
              cpu: 500m
              memory: 1Gi
            limits:
              cpu: "2"
              memory: 4Gi
          volumeMounts:
            - name: workspace
              mountPath: /workspace
---
apiVersion: extensions.agents.x-k8s.io/v1beta1
kind: SandboxWarmPool
metadata:
  name: ${agentSandbox.warmPool}
  namespace: ${env.namespace}
spec:
  replicas: 0
  sandboxTemplateRef:
    name: ${agentSandbox.template}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: openhands-sandbox-server
  namespace: ${env.namespace}
rules:
  - apiGroups: ["extensions.agents.x-k8s.io"]
    resources: ["sandboxclaims"]
    verbs: ["create", "get", "list", "watch", "delete"]
  - apiGroups: ["agents.x-k8s.io"]
    resources: ["sandboxes"]
    verbs: ["get", "list", "watch", "patch"]
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["get"]
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
      volumes:
        - name: auth
          emptyDir:
            medium: Memory
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

export function renderWorkspaceStorageClass() {
  const storage = config.workspaceStorage;
  return `apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: ${storage.storageClass}
provisioner: disk.csi.azure.com
parameters:
  skuName: ${storage.skuName}
reclaimPolicy: Retain
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
            name: "BlockUnapprovedClients",
            priority: 1,
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
    input: renderSecretProviderClass(environment, runtime.clientId),
  });
  kubectl(["apply", "-f", "-"], {
    input: renderConversationStorageClass(),
  });
  kubectl(["apply", "-f", "-"], {
    input: renderWorkspaceStorageClass(),
  });
  kubectl(["apply", "-f", "-"], {
    input: renderConversationPvc(environment),
  });
  kubectl(["apply", "-f", "-"], {
    input: renderAgentSandboxResources(environment),
  });
  ensureFrontDoor(environment);
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
  } else {
    az([
      "postgres",
      "flexible-server",
      "update",
      "--resource-group",
      postgres.resourceGroup,
      "--name",
      postgres.serverName,
      "--set",
      "authConfig.activeDirectoryAuth=Enabled",
      `authConfig.tenantId=${config.azure.tenantId}`,
      "--password-auth",
      "Disabled",
      "--output",
      "none",
    ]);
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
  for (const env of Object.values(config.environments)) {
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
        `[?name=='${env.database}'].name | [0]`,
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
        env.database,
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
  bootstrapBuild();
  ensureRuntimeNodePool();
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
  const ref = option(args, "--ref", "HEAD");
  const commit = resolveCommit(ref);
  verifyCommitIsPushed(commit);
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
    input: renderBuildJob({ commit }),
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
) {
  const env = config.environments[environment];
  const clientId = runtimeClientId(environment);
  kubectl(["apply", "-f", "-"], {
    input: renderSecretProviderClass(environment, clientId),
  });
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
  await waitForSecretKey(
    env.namespace,
    "openhands-halo-secrets",
    "trustedIdentityAssertion",
  );
  kubectl(["apply", "-f", "-"], {
    input: renderAgentSandboxResources(environment, agentServerDigest),
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
  kubectl(["apply", "-f", "-"], {
    input: renderSandboxServerResources(
      environment,
      sandboxServerDigest,
      clientId,
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
}

function candidateDigests() {
  const env = config.environments.candidate;
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
  const canvasPrefix = `${config.azure.acrLoginServer}/${config.build.repository}@`;
  const agentServerPrefix = `${config.azure.acrLoginServer}/${config.build.agentServerRepository}@`;
  const sandboxServerPrefix = `${config.azure.acrLoginServer}/${config.build.sandboxServerRepository}@`;
  if (!canvasImage.startsWith(canvasPrefix)) {
    throw new Error(
      `Candidate Canvas is not deployed by immutable digest: ${canvasImage}`,
    );
  }
  if (!sandboxServerImage.startsWith(sandboxServerPrefix)) {
    throw new Error(
      `Candidate Sandbox Server is not deployed by immutable digest: ${sandboxServerImage}`,
    );
  }
  if (!agentServerImage.startsWith(agentServerPrefix)) {
    throw new Error(
      `Candidate Agent Server is not deployed by immutable digest: ${agentServerImage}`,
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
  };
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
  const digests = candidateDigests();
  const expectedCanvasDigest = option(args, "--canvas-digest");
  const expectedAgentServerDigest = option(args, "--agent-server-digest");
  const expectedSandboxServerDigest = option(args, "--sandbox-server-digest");
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
  console.log(
    `Promoting candidate digests ${digests.canvas}, ${digests.agentServer}, and ${digests.sandboxServer}`,
  );
  await deploy(
    "primary",
    digests.canvas,
    digests.agentServer,
    digests.sandboxServer,
  );
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
  }
}

function usage() {
  console.log(`Usage:
  npm run halo -- bootstrap
  npm run halo -- bootstrap-ci [--github-app-id <id> --github-app-installation-id <id> --github-app-private-key <path>]
  npm run halo -- build --ref <git-ref>
  npm run halo -- deploy-candidate --canvas-digest sha256:<digest> --agent-server-digest sha256:<digest> --sandbox-server-digest sha256:<digest>
  npm run halo -- promote [--canvas-digest sha256:<candidate-digest> --agent-server-digest sha256:<candidate-digest> --sandbox-server-digest sha256:<candidate-digest>]
  npm run halo -- status`);
}

async function main(args = process.argv.slice(2)) {
  const [command] = args;
  switch (command) {
    case "bootstrap":
      await bootstrap();
      break;
    case "bootstrap-ci":
      bootstrapCi(args.slice(1));
      break;
    case "build":
      await build(args.slice(1));
      break;
    case "deploy-candidate":
      await deploy(
        "candidate",
        normalizeDigest(option(args, "--canvas-digest")),
        normalizeDigest(option(args, "--agent-server-digest")),
        normalizeDigest(option(args, "--sandbox-server-digest")),
      );
      break;
    case "promote":
      await promote(args.slice(1));
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
