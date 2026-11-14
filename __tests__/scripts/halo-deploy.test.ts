// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  appGatewayNsgRuleArgs,
  buildDigestsFromPodList,
  buildNodePoolCreateArgs,
  entraIdentifierUri,
  frontDoorOriginCreateArgs,
  frontDoorOriginGroupCreateArgs,
  githubOAuthCallbackInstructions,
  imageReference,
  normalizeDigest,
  postgresServerCreateArgs,
  renderArcControllerValues,
  renderArcRunnerRbac,
  renderArcRunnerValues,
  renderAgentSandboxResources,
  renderAppServerMigrationJob,
  renderAppServerResources,
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
  validateDistinctAppServerSecrets,
  validateAppServerDeploymentConfig,
  validateBuildNodePool,
  validateEnterpriseSourcePin,
} from "../../scripts/halo-deploy.mjs";

const digest = `sha256:${"a".repeat(64)}`;
const commit = "84d224f45e7647c3a04d4b8ac4af47af22a23b12";
const haloConfig = JSON.parse(
  readFileSync("deploy/halo/config.json", "utf8"),
) as {
  source: {
    enterpriseRepository: string;
    enterpriseRef: string;
    enterpriseRevisionValidated: boolean;
  };
  environments: Record<
    "candidate" | "primary",
    {
      githubApp: {
        slug: string | null;
        secrets: Record<
          | "appId"
          | "clientId"
          | "clientSecret"
          | "privateKey"
          | "webhookSecret",
          string | null
        >;
      };
      secrets: {
        ohSecretKey: string;
        jwtSecret: string | null;
        trustedIdentityAssertion: string;
        trustedIdentityMappings: string | null;
      };
    }
  >;
};
const deployScript = readFileSync("scripts/halo-deploy.mjs", "utf8");

describe("Halo deployment automation", () => {
  it("requires immutable image digests", () => {
    expect(normalizeDigest(digest)).toBe(digest);
    expect(() => normalizeDigest("84d224f45")).toThrow(/immutable sha256/);
    expect(imageReference("registry.example", "openhands-halo", digest)).toBe(
      `registry.example/openhands-halo@${digest}`,
    );
  });

  it("pins the reviewed Enterprise composition revision", () => {
    expect(haloConfig.source.enterpriseRepository).toBe(
      "https://github.com/ghermann-msft/enterprise.git",
    );
    expect(haloConfig.source.enterpriseRef).toBe(
      "e7fa6b6524a1028efc02023eb6814c85ccf18dfe",
    );
    expect(haloConfig.source.enterpriseRevisionValidated).toBe(true);
    expect(() => validateEnterpriseSourcePin()).not.toThrow();
  });

  it("provisions only the dedicated PPE GitHub App", () => {
    const candidate = haloConfig.environments.candidate.githubApp;
    const primary = haloConfig.environments.primary.githubApp;

    expect(candidate).not.toBe(primary);
    expect(candidate.slug).toBe("openhands-halo-ppe");
    expect(candidate.secrets).toEqual({
      appId: "halo-ppe-github-app-id",
      clientId: "halo-ppe-github-app-client-id",
      clientSecret: "halo-ppe-github-app-client-secret",
      privateKey: "halo-ppe-github-app-private-key",
      webhookSecret: "halo-ppe-github-app-webhook-secret",
    });

    expect(primary.slug).toBeNull();
    expect(Object.values(primary.secrets)).toEqual([
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  it("uses a dedicated PPE Enterprise JWT secret and leaves primary blocked", () => {
    const candidate = haloConfig.environments.candidate.secrets;
    const primary = haloConfig.environments.primary.secrets;

    expect(candidate.jwtSecret).toBe("halo-ppe-enterprise-jwt-secret");
    expect(candidate.jwtSecret).not.toBe(candidate.ohSecretKey);
    expect(candidate.jwtSecret).not.toBe(candidate.trustedIdentityAssertion);
    expect(candidate.trustedIdentityMappings).toBe(
      "halo-ppe-trusted-identity-mappings",
    );
    expect(primary.jwtSecret).toBeNull();
    expect(primary.trustedIdentityMappings).toBeNull();
  });

  it("renders an isolated privileged cached build for the exact commit", () => {
    const job = renderBuildJob({ commit });

    expect(job).toContain(`git checkout --detach ${commit}`);
    expect(job).toContain(
      "git checkout --detach 705616fe2fd01dbe5fda92a5b31d24d4f29c1b79",
    );
    expect(job).toContain(
      "git clone --filter=blob:none --no-checkout https://github.com/ghermann-msft/enterprise.git /enterprise",
    );
    expect(haloConfig.source.enterpriseRef).toMatch(/^[a-f0-9]{40}$/);
    expect(job).toContain(
      `git checkout --detach ${haloConfig.source.enterpriseRef}`,
    );
    expect(job).toContain('grep -q "azure-identity==1.25.2" pyproject.toml');
    expect(job).toContain(
      'grep -q "AZURE_POSTGRES_SCOPE" openhands/app_server/services/db_session_injector.py',
    );
    expect(job).toContain(
      'grep -q "_get_azure_postgres_token" openhands/app_server/services/db_session_injector.py',
    );
    expect(job).toContain(
      'grep -q "_create_async_azure_db_connection" openhands/app_server/services/db_session_injector.py',
    );
    expect(job).toContain('grep -q "DB_AZURE_IDENTITY" migrations/env.py');
    expect(job).toContain(
      "test -f migrations/versions/216_reconcile_github_oauth_provider.py",
    );
    expect(job).toContain(
      `grep -Eq "revision(: str)? = '216'" migrations/versions/216_reconcile_github_oauth_provider.py`,
    );
    expect(job).toContain(
      `grep -Eq "down_revision(: str.*)? = '215'" migrations/versions/216_reconcile_github_oauth_provider.py`,
    );
    expect(job).toContain(
      'grep -q "reconcile_github_oauth_provider" migrations/versions/216_reconcile_github_oauth_provider.py',
    );
    expect(job).toContain(
      "test -f tests/unit/test_migration_216_reconcile_github_oauth_provider.py",
    );
    expect(job).toContain(
      "test -f migrations/versions/217_add_trusted_identity_mappings.py",
    );
    expect(job).toContain(
      `grep -Eq "revision(: str)? = '217'" migrations/versions/217_add_trusted_identity_mappings.py`,
    );
    expect(job).toContain(
      `grep -Eq "down_revision(: str.*)? = '216'" migrations/versions/217_add_trusted_identity_mappings.py`,
    );
    expect(job).toContain("test -f storage/trusted_identity_mapping_store.py");
    expect(job).toContain(
      'grep -q "OH_TRUSTED_IDENTITY_MAPPINGS" storage/trusted_identity_mapping_store.py',
    );
    expect(job).toContain(
      'grep -q "reconcile_trusted_identity_mappings_from_env" storage/trusted_identity_mapping_store.py',
    );
    expect(job).toContain(
      "test -f tests/unit/storage/test_trusted_identity_mapping_store.py",
    );
    expect(job).toContain(
      'grep -q "_reconcile_trusted_identity_mappings" server/app_lifespan/saas_app_lifespan_service.py',
    );
    expect(job).toContain(
      'grep -q "OH_WEB_CLIENT_FEATURE_FLAGS_ENABLE_OAUTH_V2_LOGIN" server/auth/constants.py',
    );
    expect(job).toContain(
      'grep -q "SANDBOX_SERVER_URL" openhands/app_server/config.py',
    );
    expect(job).toContain(
      'grep -q "RemoteSandboxServiceInjector" openhands/app_server/config.py',
    );
    expect(job).toContain(
      'grep -q "RemoteSandboxSpecServiceInjector" openhands/app_server/config.py',
    );
    expect(job).toContain(
      "test -f tests/unit/app_server/test_remote_sandbox_config.py",
    );
    expect(job).toContain(
      'grep -q "test_sandbox_server_url_selects_remote_sandbox_services" tests/unit/app_server/test_remote_sandbox_config.py',
    );
    expect(job).toContain("test -f server/auth/trusted_identity.py");
    expect(job).toContain(
      'grep -q "saas_user_auth_from_trusted_identity" server/auth/saas_user_auth.py',
    );
    expect(job).toContain(
      'grep -q "public_skills = tuple(load_public_skills())" storage/agent_profile_resolution.py',
    );
    expect(job).toContain(
      'grep -q "skills=lambda: list(public_skills)" storage/agent_profile_resolution.py',
    );
    expect(job).toContain(
      'grep -q "public_skill_names=lambda:" storage/agent_profile_resolution.py',
    );
    expect(job).toContain(
      '! grep -q "discover_profile_skills" storage/agent_profile_resolution.py',
    );
    expect(job).toContain(`OPENHANDS_BUILD_GIT_SHA=${commit}`);
    expect(job).toContain(
      "--opt build-arg:VITE_HOSTED_PROFILE_SKILL_ALLOW_LIST=true",
    );
    expect(job).toContain("containers/app/Dockerfile");
    expect(job).toContain("--opt target=openhands-sandbox-server");
    expect(job).toContain("--opt target=enterprise-server");
    expect(job).toContain(
      "name=uhunrealhaacukmdbkacr.azurecr.io/openhands-enterprise-server:",
    );
    expect(job).toContain(
      "name=uhunrealhaacukmdbkacr.azurecr.io/openhands-sandbox-server:",
    );
    expect(job).toContain(
      "name=uhunrealhaacukmdbkacr.azurecr.io/openhands-agent-server:",
    );
    expect(job).toContain(
      "git checkout --detach b1d818a6078691cd765e05adbc60cd5fecb4c671",
    );
    expect(job).toContain(
      "filename=openhands-agent-server/openhands/agent_server/docker/Dockerfile",
    );
    expect(job).toContain("--opt target=binary");
    expect(job).toContain(
      "AGENT_SERVER_SDK_GIT_REPOSITORY=https://github.com/ghermann-msft/software-agent-sdk.git",
    );
    expect(job).toContain(
      "AGENT_SERVER_SDK_GIT_REF=b1d818a6078691cd765e05adbc60cd5fecb4c671",
    );
    expect(job).toContain(
      "SOFTWARE_AGENT_SDK_REPOSITORY=https://github.com/ghermann-msft/software-agent-sdk.git",
    );
    expect(job).toContain(
      "SOFTWARE_AGENT_SDK_REF=b1d818a6078691cd765e05adbc60cd5fecb4c671",
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

  it("reads every immutable digest reported by the completed build container", () => {
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
                        appServer: `sha256:${"d".repeat(64)}`,
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
      agentServer: `sha256:${"c".repeat(64)}`,
      appServer: `sha256:${"d".repeat(64)}`,
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
      'resources: ["sandboxtemplates", "sandboxwarmpools", "sandboxclaims"]',
    );
    expect(rbac).toContain(
      'verbs: ["create", "delete", "get", "list", "patch", "update", "watch"]',
    );
    expect(rbac).toContain('resources: ["sandboxes"]');
    expect(rbac).toContain('verbs: ["get", "list", "watch", "patch"]');
    expect(rbac).toContain('resources: ["pods"]');
    expect(rbac).toContain('verbs: ["get"]');
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
    expect(spc).toContain("objectName: halo-ppe-enterprise-jwt-secret");
    expect(spc).toContain("objectAlias: jwtSecret");
    expect(spc).toContain("objectName: halo-ppe-trusted-identity-mappings");
    expect(spc).toContain("objectAlias: trustedIdentityMappings");
    expect(spc).toContain("objectName: halo-ppe-github-app-id");
    expect(spc).toContain("objectName: halo-ppe-github-app-client-id");
    expect(spc).toContain("objectName: halo-ppe-github-app-client-secret");
    expect(spc).toContain("objectName: halo-ppe-github-app-private-key");
    expect(spc).toContain("objectName: halo-ppe-github-app-webhook-secret");
    expect(spc).toContain("objectName: githubAppClientId");
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
    expect(values).not.toContain("OH_TRUSTED_IDENTITY_MAPPINGS");
    expect(values).toContain(
      "name: SANDBOX_SERVER_URL\n      value: http://openhands-sandbox-server:3000",
    );
    expect(values).toContain(
      "name: APP_SERVER_URL\n      value: http://openhands-app-server:3000",
    );
    expect(values).toContain(
      "name: OH_TRUSTED_IDENTITY_ASSERTION_AUDIENCE\n      value: openhands-sandbox-server",
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

  it("renders Enterprise app API and migration ownership", () => {
    const appDigest = `sha256:${"d".repeat(64)}`;
    const migration = renderAppServerMigrationJob(
      "candidate",
      appDigest,
      "runtime-client-id",
    );
    const resources = renderAppServerResources(
      "candidate",
      appDigest,
      "runtime-client-id",
    );

    expect(migration).toContain("kind: Job");
    expect(migration).toContain("name: openhands-app-server-migrate");
    expect(migration).toContain("automountServiceAccountToken: true");
    expect(migration).toContain(
      `image: uhunrealhaacukmdbkacr.azurecr.io/openhands-enterprise-server@${appDigest}`,
    );
    expect(migration).toContain(
      'export JWT_SECRET="$(cat /mnt/secrets-store/jwtSecret)"',
    );
    expect(migration).toContain(
      'export GITHUB_APP_CLIENT_ID="$(cat /mnt/secrets-store/githubAppClientId)"',
    );
    expect(migration).toContain(
      'export GITHUB_APP_CLIENT_SECRET="$(cat /mnt/secrets-store/githubAppClientSecret)"',
    );
    expect(migration).toContain("exec alembic upgrade head");
    expect(migration).toContain("mountPath: /mnt/secrets-store");
    expect(migration).toContain("secretProviderClass: openhands-halo-secrets");
    expect(migration).toContain(
      'name: DB_AZURE_IDENTITY\n              value: "true"',
    );
    expect(migration).toContain(
      'name: DB_NAME\n              value: "openhands_halo_ppe"',
    );
    expect(migration).not.toContain("DB_PASS");
    expect(migration).not.toContain("GITHUB_APP_PRIVATE_KEY");

    expect(resources).toContain("kind: Deployment");
    expect(resources).toContain("name: openhands-app-server");
    expect(resources).toContain("automountServiceAccountToken: true");
    expect(resources).toContain('command: ["/app/entrypoint.sh"]');
    expect(resources).toContain(
      'args: ["uvicorn", "saas_server:app", "--host", "0.0.0.0", "--port", "3000"]',
    );
    expect(resources).toContain(
      "name: OPENHANDS_CONFIG_CLS\n              value: server.config.SaaSServerConfig",
    );
    expect(resources).toContain(
      'name: RUN_MIGRATIONS_ON_STARTUP\n              value: "false"',
    );
    expect(resources).toContain(
      "name: SANDBOX_SERVER_URL\n              value: http://openhands-sandbox-server:3000",
    );
    expect(resources).toContain(
      "name: OH_TRUSTED_IDENTITY_ASSERTION_AUDIENCE\n              value: openhands-sandbox-server",
    );
    expect(resources).toContain(
      "name: OH_TRUSTED_IDENTITY_MAPPINGS\n              valueFrom:",
    );
    expect(resources).toContain("key: trustedIdentityMappings");
    expect(resources).toContain("name: JWT_SECRET\n              valueFrom:");
    expect(resources).toContain(
      'name: OH_WEB_CLIENT_FEATURE_FLAGS_ENABLE_OAUTH_V2_LOGIN\n              value: "true"',
    );
    expect(resources).toContain(
      'name: OH_WEB_CLIENT_FEATURE_FLAGS_ENABLE_CANVAS_INTEGRATIONS\n              value: "true"',
    );
    expect(resources).toContain("name: GITHUB_APP_SLUG");
    expect(resources).toContain("name: GITHUB_APP_ID");
    expect(resources).toContain("name: GITHUB_APP_CLIENT_ID");
    expect(resources).toContain("name: GITHUB_APP_CLIENT_SECRET");
    expect(resources).toContain("name: GITHUB_APP_PRIVATE_KEY");
    expect(resources).toContain("name: GITHUB_APP_WEBHOOK_SECRET");
    expect(resources).not.toContain(
      "name: OH_SECRET_KEY\n              valueFrom:",
    );
    expect(resources).toContain("path: /health");
    expect(resources).toContain("kind: Service");
  });

  it("keeps candidate secrets separated and primary deployment fail-closed", () => {
    expect(() => validateAppServerDeploymentConfig("candidate")).not.toThrow();
    expect(() => validateAppServerDeploymentConfig("primary")).toThrow(
      /dedicated Enterprise JWT_SECRET Key Vault alias/,
    );
    expect(() => validateAppServerDeploymentConfig("primary")).toThrow(
      /dedicated GitHub App/,
    );
    expect(() => validateAppServerDeploymentConfig("primary")).toThrow(
      /OH_TRUSTED_IDENTITY_MAPPINGS/,
    );
  });

  it("refuses to reuse the trusted assertion key for Enterprise encryption", () => {
    expect(() =>
      validateDistinctAppServerSecrets("candidate", {
        jwtSecret: "shared-key",
        trustedIdentityAssertion: "shared-key",
      }),
    ).toThrow(/distinct JWT_SECRET and trusted identity assertion/);
    expect(() =>
      validateDistinctAppServerSecrets("candidate", {
        jwtSecret: "jwt-key",
        trustedIdentityAssertion: "assertion-key",
      }),
    ).not.toThrow();
  });

  it("keeps GitHub OAuth provider IDs environment-local", () => {
    const candidate = githubOAuthCallbackInstructions("candidate");
    const primary = githubOAuthCallbackInstructions("primary");

    expect(candidate).toContain("FROM auth_providers");
    expect(candidate).toContain("details->>'provider_type' = 'github'");
    expect(candidate).not.toContain("SELECT details");
    expect(candidate).toContain(
      "https://openhands-ppe-gsbxe2cef0d4gefc.b01.azurefd.net/oauth/<id>/callback",
    );
    expect(primary).toContain(
      "https://openhands-h0e3cucrh3gfg3gr.b01.azurefd.net/oauth/<id>/callback",
    );
    expect(candidate).toContain(
      "https://openhands-ppe-gsbxe2cef0d4gefc.b01.azurefd.net/integration/github/events",
    );
    expect(candidate).not.toContain("/oauth/1/callback");
    expect(primary).not.toContain("/oauth/1/callback");
  });

  it("completes Enterprise migrations before rolling out the app API and Canvas", () => {
    const migration = deployScript.indexOf(
      "input: renderAppServerMigrationJob(",
    );
    const migrationWait = deployScript.indexOf(
      "`job/${config.appServer.migrationJob}`",
      migration,
    );
    const appServer = deployScript.indexOf(
      "input: renderAppServerResources(",
      migrationWait,
    );
    const agentSandbox = deployScript.indexOf(
      "input: renderAgentSandboxResources(",
      migrationWait,
    );
    const sandboxServer = deployScript.indexOf(
      "input: renderSandboxServerResources(",
      migrationWait,
    );
    const canvasValues = deployScript.indexOf(
      "renderHelmValues(environment, canvasDigest, clientId)",
      appServer,
    );

    expect(migration).toBeGreaterThan(0);
    expect(migrationWait).toBeGreaterThan(migration);
    expect(agentSandbox).toBeGreaterThan(migrationWait);
    expect(sandboxServer).toBeGreaterThan(migrationWait);
    expect(appServer).toBeGreaterThan(migrationWait);
    expect(canvasValues).toBeGreaterThan(appServer);
  });

  it("renders a separated Kubernetes Sandbox Server control plane", () => {
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
      "name: RUNTIME\n              value: kubernetes",
    );
    expect(resources).toContain(
      "name: OH_SANDBOX_SANDBOX_URL_PATTERN\n              value: https://openhands-ppe-gsbxe2cef0d4gefc.b01.azurefd.net/sandboxes/{sandbox_name}",
    );
    expect(resources).toContain(
      "name: OH_SANDBOX_CLAIM_NAME_PREFIX\n              value: openhands-sandbox",
    );
    expect(resources).not.toContain("DB_PASS");
    expect(resources).not.toContain("DB_HOST");
    expect(resources).not.toContain("DB_NAME");
    expect(resources).not.toContain("DB_PASS");
    expect(resources).not.toContain("OPENHANDS_CONFIG_CLS");
    expect(resources).not.toContain("OH_TRUSTED_IDENTITY_ASSERTION_SECRET");
    expect(resources).not.toContain("LLM_MODEL");
    expect(resources).toContain("containerPort: 3000");
    expect(resources).toContain("path: /ready");
    expect(resources).toContain("kind: Service");
  });

  it("renders isolated agent-sandbox resources for each environment", () => {
    const agentServerDigest = `sha256:${"c".repeat(64)}`;
    const resources = renderAgentSandboxResources(
      "candidate",
      agentServerDigest,
    );

    expect(resources).toContain(
      "apiVersion: extensions.agents.x-k8s.io/v1beta1",
    );
    expect(resources).toContain("kind: SandboxTemplate");
    expect(resources).toContain("namespace: openhands-halo-ppe");
    expect(resources).toContain("envVarsInjectionPolicy: Allowed");
    expect(resources).toContain("service: true");
    expect(resources).toContain(
      `image: uhunrealhaacukmdbkacr.azurecr.io/openhands-agent-server@${agentServerDigest}`,
    );
    expect(resources).not.toContain("AGENT_CANVAS_BACKEND");
    expect(resources).not.toContain("agent-canvas-session-key");
    expect(resources).toContain(
      "name: openhands-state\n          emptyDir: {}",
    );
    expect(resources).toContain(
      "name: openhands-state\n              mountPath: /home/openhands/.openhands",
    );
    expect(resources).not.toContain(
      "mountPath: /home/openhands/.openhands/agent-canvas",
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
    expect(resources).toContain('resources: ["pods"]');
    expect(resources).toContain('verbs: ["get"]');
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
