# @firetrace/mcp

Model Context Protocol server for [FireTrace](https://github.com/IdkwhatImD0ing/FireTrace). Lets an AI agent list, inspect, record, and delete LLM traces through a scoped project API key.

## stdio bridge

```bash
FIRETRACE_ENDPOINT=https://your-deployment.vercel.app \
FIRETRACE_API_KEY=ft_live_... \
npx -y @firetrace/mcp
```

The bridge validates the key against `GET /api/v1/key`, then exposes only the tools the key's scopes allow (`traces:read`, `traces:write`, `traces:delete`). Diagnostics go to stderr; stdout is the MCP stream.

Most clients can instead talk to the deployment directly at `POST /api/mcp` with the same bearer key. See `docs/mcp.md` in the repository for client configuration and the tool reference.

## Library use

```ts
import { createFireTraceMcpServer, HttpBackend } from "@firetrace/mcp";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const backend = new HttpBackend({
  endpoint: "https://your-deployment.vercel.app",
  apiKey: "ft_live_...",
});
await backend.init();
const server = createFireTraceMcpServer(backend);
await server.connect(new StdioServerTransport());
```

Implement `TraceBackend` to put the same tools over any other store.

MIT.
