import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // firebase-admin (gRPC, protobuf) must stay a Node external rather than be bundled.
  serverExternalPackages: ["firebase-admin", "@modelcontextprotocol/sdk"],
  // Workspace packages ship TypeScript sources; Next compiles them in place.
  transpilePackages: ["@firetrace/mcp"],
  // /docs renders the committed Markdown; make sure the files ship with the functions.
  outputFileTracingIncludes: { "/docs/[slug]": ["./docs/*.md"] },
};

export default nextConfig;
