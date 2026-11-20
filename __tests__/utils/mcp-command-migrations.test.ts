import { describe, expect, it } from "vitest";
import {
  buildMcpCommandMigration,
  LEGACY_PERFORCE_MCP_COMMAND,
  PERFORCE_MCP_COMMAND,
} from "#/utils/mcp-command-migrations";

describe("buildMcpCommandMigration", () => {
  it("patches only exact legacy Perforce commands", () => {
    expect(
      buildMcpCommandMigration({
        MCC: {
          transport: "stdio",
          command: LEGACY_PERFORCE_MCP_COMMAND,
          args: ["--readonly"],
          env: {
            P4PORT: "ssl:mcc.example.com:1666",
            P4PASSWD: "**********",
          },
        },
        Miramonte: {
          transport: "stdio",
          command: LEGACY_PERFORCE_MCP_COMMAND,
          args: ["--readonly"],
        },
        custom: {
          transport: "stdio",
          command: "/opt/tools/p4-mcp-server",
        },
        remote: {
          transport: "http",
          url: "https://example.com/mcp",
        },
      }),
    ).toEqual({
      MCC: { command: PERFORCE_MCP_COMMAND },
      Miramonte: { command: PERFORCE_MCP_COMMAND },
    });
  });

  it("returns null when no saved command needs migration", () => {
    expect(
      buildMcpCommandMigration({
        perforce: {
          transport: "stdio",
          command: PERFORCE_MCP_COMMAND,
          args: ["--readonly"],
        },
      }),
    ).toBeNull();
  });
});
