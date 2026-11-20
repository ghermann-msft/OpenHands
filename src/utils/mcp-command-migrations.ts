import type {
  MCPConfig,
  MCPConfigPatch,
  MCPServerPatch,
} from "@openhands/typescript-client";

export const LEGACY_PERFORCE_MCP_COMMAND = "/usr/local/bin/p4-mcp-server";
export const PERFORCE_MCP_COMMAND = "p4-mcp-server";

export function normalizeMcpCommand(command: string): string {
  return command === LEGACY_PERFORCE_MCP_COMMAND
    ? PERFORCE_MCP_COMMAND
    : command;
}

export function buildMcpCommandMigration(
  config: MCPConfig,
): MCPConfigPatch | null {
  const patch: MCPConfigPatch = {};
  for (const [settingsKey, server] of Object.entries(config)) {
    if (
      server.transport === "stdio" &&
      server.command === LEGACY_PERFORCE_MCP_COMMAND
    ) {
      patch[settingsKey] = {
        command: PERFORCE_MCP_COMMAND,
      } as MCPServerPatch;
    }
  }
  return Object.keys(patch).length > 0 ? patch : null;
}
