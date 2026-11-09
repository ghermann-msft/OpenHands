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
    ["ls-remote", config.source.repository, `refs/heads/${config.source.branch}`],
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

function ensureEntraApplication(environment) {
  const env = config.environments[environment];
  const application = JSON.parse(
    az(
      ["ad", "app", "show", "--id", env.entraClientId, "--output", "json"],
      { capture: true },
    ),
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

export function renderBuildJob({ commit, builderClientId }) {
  const short = commit.slice(0, 9);
  const build = config.build;
  const image = `${config.azure.acrLoginServer}/${build.repository}:${short}`;
  const cache = `${config.azure.acrLoginServer}/${build.repository}:${build.cacheTag}`;
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
  ttlSecondsAfterFinished: 1800
  template:
    metadata:
      labels:
        app.kubernetes.io/name: openhands-halo-builder
        azure.workload.identity/use: "true"
    spec:
      hostUsers: false
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
              buildkitd \\
                --addr unix:///run/buildkit/buildkitd.sock \\
                --oci-worker-snapshotter=native \\
                --oci-worker-no-process-sandbox &
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
                --opt build-arg:AUTOMATION_VERSION=${defaults.versions.automation} \\
                --opt build-arg:VITE_BASE_PATH=${defaults.paths.canvasBasePath} \\
                --opt build-arg:OPENHANDS_BUILD_GIT_SHA=${commit} \\
                --opt build-arg:OPENHANDS_BUILD_GIT_REF=${config.source.branch} \\
                --opt build-arg:AGENT_CANVAS_VERSION=halo-${short} \\
                --import-cache type=registry,ref=${cache} \\
                --export-cache type=registry,ref=${cache},mode=max,compression=zstd,ignore-error=true \\
                --output type=image,name=${image},push=true
          env:
            - name: DOCKER_CONFIG
              value: /docker
          securityContext:
            runAsUser: 0
            runAsGroup: 0
            allowPrivilegeEscalation: false
            seccompProfile:
              type: Unconfined
            appArmorProfile:
              type: Unconfined
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
            - name: docker-config
              mountPath: /docker
              readOnly: true
      volumes:
        - name: source
          emptyDir:
            sizeLimit: 8Gi
        - name: docker-config
          emptyDir: {}
`;
}

function bootstrapBuild() {
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
  ensureRole({ principalId: builder.principalId, role: "AcrPush", scope: acrId });
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
  return `fullnameOverride: openhands-halo
image:
  repository: ${config.azure.acrLoginServer}/${config.build.repository}
  digest: ${digest}
  pullPolicy: IfNotPresent
serviceAccount:
  create: true
  name: ${env.serviceAccount}
  automountServiceAccountToken: false
  annotations:
    azure.workload.identity/client-id: ${quote(runtimeClientId)}
podLabels:
  azure.workload.identity/use: "true"
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
    - name: AUTOMATION_KV_SECRET
      valueFrom:
        secretKeyRef:
          name: openhands-halo-secrets
          key: automationKvSecret
extraVolumes:
  - name: halo-secrets-store
    csi:
      driver: secrets-store.csi.k8s.io
      readOnly: true
      volumeAttributes:
        secretProviderClass: openhands-halo-secrets
extraVolumeMounts:
  - name: halo-secrets-store
    mountPath: /mnt/secrets-store
    readOnly: true
`;
}

function ensureFrontDoor(environment) {
  const env = config.environments[environment];
  const common = [
    "--resource-group",
    config.azure.resourceGroup,
    "--profile-name",
    config.azure.frontDoorProfile,
  ];
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
    az([
      "afd",
      "origin-group",
      "create",
      ...common,
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
      "--output",
      "none",
    ]);
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
    az([
      "afd",
      "origin",
      "create",
      ...common,
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
      "--certificate-name-check-enabled",
      "false",
      "--output",
      "none",
    ]);
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

function bootstrapEnvironment(environment, runtime) {
  const env = config.environments[environment];
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
  ensureFederatedCredential({
    identityName: config.identities.runtime,
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
  ensureFrontDoor(environment);
}

function bootstrap() {
  bootstrapBuild();
  const runtime = identity(config.identities.runtime);
  bootstrapEnvironment("candidate", runtime);
  bootstrapEnvironment("primary", runtime);
}

function build(args) {
  const ref = option(args, "--ref", "HEAD");
  const commit = resolveCommit(ref);
  verifyCommitIsPushed(commit);
  const builder = bootstrapBuild();
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
    input: renderBuildJob({ commit, builderClientId: builder.clientId }),
  });
  try {
    kubectl([
      "-n",
      config.build.namespace,
      "wait",
      "--for=condition=complete",
      `job/${job}`,
      "--timeout=5400s",
    ]);
  } catch (error) {
    tryRun("kubectl", [
      "-n",
      config.build.namespace,
      "logs",
      `job/${job}`,
      "--all-containers=true",
      "--prefix",
      "--tail=300",
    ]);
    throw error;
  }
  const digest = az(
    [
      "acr",
      "manifest",
      "show-metadata",
      "--registry",
      config.azure.acrName,
      "--name",
      `${config.build.repository}:${short}`,
      "--query",
      "digest",
      "--output",
      "tsv",
    ],
    { capture: true },
  );
  console.log(`IMAGE_DIGEST=${normalizeDigest(digest)}`);
}

async function waitForReady(host) {
  const deadline = Date.now() + 15 * 60 * 1000;
  let lastError = "not attempted";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`https://${host}/ready`, {
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  throw new Error(`Timed out waiting for https://${host}/ready: ${lastError}`);
}

function enableEndpoint(environment) {
  const env = config.environments[environment];
  az([
    "afd",
    "endpoint",
    "update",
    "--resource-group",
    config.azure.resourceGroup,
    "--profile-name",
    config.azure.frontDoorProfile,
    "--endpoint-name",
    env.frontDoorEndpoint,
    "--enabled-state",
    "Enabled",
    "--output",
    "none",
  ]);
}

async function deploy(environment, digest) {
  const runtime = identity(config.identities.runtime);
  bootstrapEnvironment(environment, runtime);
  const env = config.environments[environment];
  const valuesPath = join(
    tmpdir(),
    `openhands-halo-${environment}-${process.pid}.yaml`,
  );
  writeFileSync(
    valuesPath,
    renderHelmValues(environment, digest, runtime.clientId),
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
  enableEndpoint(environment);
  await waitForReady(env.frontDoorHost);
  console.log(
    `${environment.toUpperCase()}_IMAGE=${imageReference(config.azure.acrLoginServer, config.build.repository, digest)}`,
  );
}

function candidateDigest() {
  const env = config.environments.candidate;
  const image = kubectl(
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
  const expectedPrefix = `${config.azure.acrLoginServer}/${config.build.repository}@`;
  if (!image.startsWith(expectedPrefix)) {
    throw new Error(`Candidate is not deployed by immutable digest: ${image}`);
  }
  return normalizeDigest(image.slice(expectedPrefix.length));
}

async function promote() {
  const env = config.environments.candidate;
  kubectl([
    "-n",
    env.namespace,
    "rollout",
    "status",
    "statefulset/openhands-halo",
    "--timeout=5m",
  ]);
  await waitForReady(env.frontDoorHost);
  const digest = candidateDigest();
  console.log(`Promoting candidate digest ${digest}`);
  await deploy("primary", digest);
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
  npm run halo -- build --ref <git-ref>
  npm run halo -- deploy-candidate --digest sha256:<digest>
  npm run halo -- promote
  npm run halo -- status`);
}

async function main(args = process.argv.slice(2)) {
  const [command] = args;
  switch (command) {
    case "bootstrap":
      bootstrap();
      break;
    case "build":
      build(args.slice(1));
      break;
    case "deploy-candidate":
      await deploy(
        "candidate",
        normalizeDigest(option(args, "--digest")),
      );
      break;
    case "promote":
      await promote();
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
