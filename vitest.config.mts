import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

/**
 * Two projects:
 *  - unit: pure functions, no network (pnpm test)
 *  - integration: runs inside `firebase emulators:exec` against the Auth and
 *    Firestore emulators (pnpm test:integration)
 * `server-only` is aliased to an empty module so server libraries can be
 * imported outside the Next.js runtime.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": `${root}src`,
      "server-only": `${root}tests/mocks/server-only.ts`,
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts", "packages/*/src/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          environment: "node",
          testTimeout: 30_000,
          hookTimeout: 90_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
