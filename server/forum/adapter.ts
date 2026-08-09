import { MemoryMcpClient } from "../memory/mcp.js";

export type ForumHealth = {
  status: "ok";
  provider: "community-v2-mcp";
  name: string;
  version: string;
  tools: string[];
  mode: "read-only";
};

export type ForumBrowseResult = {
  authority: "community-v2-mcp";
  mode: "read-only";
  content: string;
};

export class ForumAdapter {
  private readonly client: MemoryMcpClient;

  constructor(url: string, authorization = "") {
    this.client = new MemoryMcpClient(url, authorization, "Forum MCP");
  }

  async health(): Promise<ForumHealth> {
    const tools = await this.client.listTools();
    const names = tools.map((tool) => tool.name);
    if (!names.includes("forum")) throw new Error("Forum MCP does not expose the required forum tool");
    const info = this.client.serverInfo;
    return {
      status: "ok",
      provider: "community-v2-mcp",
      name: info.name,
      version: info.version,
      tools: names,
      mode: "read-only",
    };
  }

  async browseLatest(limit = 8): Promise<ForumBrowseResult> {
    const boundedLimit = Math.max(1, Math.min(20, Math.round(limit)));
    const content = String(await this.client.callTool("forum", {
      action: "browse",
      sort: "latest",
      limit: boundedLimit,
    })).trim();
    if (!content) throw new Error("Forum MCP returned an empty browse result");
    return {
      authority: "community-v2-mcp",
      mode: "read-only",
      content: content.slice(0, 8_000),
    };
  }
}

export function createForumAdapterFromEnv() {
  const url = process.env.FORUM_MCP_URL?.trim();
  if (!url) return null;
  return new ForumAdapter(url, process.env.FORUM_MCP_AUTH_TOKEN?.trim() ?? "");
}
