import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // firebase-admin (gRPC, protobuf) must stay a Node external rather than be bundled.
  serverExternalPackages: ["firebase-admin"],
};

export default nextConfig;
