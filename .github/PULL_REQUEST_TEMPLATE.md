## What and why

<!-- One paragraph. Link the issue if there is one. -->

## Checklist

- [ ] `pnpm format:check && pnpm typecheck && pnpm lint && pnpm build` pass locally
- [ ] `pnpm test` passes; `pnpm test:integration` too if server code or Firestore access changed
- [ ] No TTL, `expireAt`, scheduled cleanup, or age-based deletion of trace data was introduced
- [ ] All Firestore access still goes through the Admin SDK behind `requireOwner()` / `withApiKey()`
- [ ] Docs updated where behaviour changed (`README.md`, `docs/*.md`, package READMEs)
- [ ] `src/lib/firetrace/schema.ts` and `packages/sdk-js/src/types.ts` are still in sync if the wire format changed
- [ ] No secrets, `.env*` files, service-account JSON, or `.firebaserc` in the diff
