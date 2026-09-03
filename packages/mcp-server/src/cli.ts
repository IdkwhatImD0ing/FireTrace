import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { HttpBackend } from "./http-backend.ts";
import { createFireTraceMcpServer } from "./server.ts";

/**
 * stdio entry point: `FIRETRACE_ENDPOINT=https://... FIRETRACE_API_KEY=ft_live_... firetrace-mcp`
 * Everything on stdout is the MCP stream; diagnostics go to stderr.
 */
async function main(): Promise<void> {
  const endpoint = process.env.FIRETRACE_ENDPOINT?.trim();
  const apiKey = process.env.FIRETRACE_API_KEY?.trim();
  if (!endpoint || !apiKey) {
    console.error(
      "firetrace-mcp: set FIRETRACE_ENDPOINT (deployment origin) and FIRETRACE_API_KEY (ft_live_...).",
    );
    process.exit(2);
  }
  const backend = new HttpBackend({ endpoint, apiKey });
  try {
    const info = await backend.init();
    console.error(
      `firetrace-mcp: key ${info.keyId} → project ${info.projectId} (scopes: ${info.scopes.join(", ")})`,
    );
  } catch (err) {
    console.error(
      `firetrace-mcp: could not validate the key against ${endpoint}: ${(err as Error).message}`,
    );
    process.exit(1);
  }
  const server = createFireTraceMcpServer(backend, { version: "0.1.0" });
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error(`firetrace-mcp: ${(err as Error).stack ?? err}`);
  process.exit(1);
});
