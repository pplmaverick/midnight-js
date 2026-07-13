# Vite + WASM Resolution in Midnight dApps

When building a browser dApp with Midnight JS in a Vite monorepo, the
`@midnight-ntwrk/ledger-v8` package (which uses `wasm-bindgen`) can be
instantiated multiple times across package boundaries. This causes subtle
runtime failures where `instanceof` checks silently return `false` even
for objects of the correct type.

## Symptoms

- ZK proof generation fails with no clear error message
- `instanceof` checks on Midnight SDK objects return `false` unexpectedly
- Errors appear only in monorepo setups, not in single-package projects

## Option A: resolve.dedupe (recommended for most projects)

Add the following to your `vite.config.ts`:

```typescript
import { defineConfig } from 'vite'
import wasm from 'vite-plugin-wasm'
import topLevelAwait from 'vite-plugin-top-level-await'

export default defineConfig({
  plugins: [wasm(), topLevelAwait()],
  resolve: {
    dedupe: [
      '@midnight-ntwrk/ledger-v8',
      '@midnight-ntwrk/compact-runtime',
      '@midnight-ntwrk/midnight-js-circuits',
    ],
  },
})
```

This forces Vite to resolve these packages to a single instance across
all monorepo boundaries, preventing dual-instantiation.

**When to use:** Standard Vite monorepo setups where the frontend is a
subdirectory of a larger project.

## Option B: Custom resolveId hook + manualChunks (used in example-bboard)

The official
[example-bboard](https://github.com/midnightntwrk/example-bboard)
uses an alternative approach with a custom `resolveId` plugin and
`manualChunks` to control WASM module chunking at the bundler level.

**When to use:** Projects that need fine-grained control over chunk
splitting, or where `resolve.dedupe` alone does not resolve the issue.

## Required plugins

Both approaches require these Vite plugins to handle `wasm-bindgen`'s
ESM import syntax, which Vite/esbuild does not support natively:

```bash
npm install -D vite-plugin-wasm vite-plugin-top-level-await
```

## References

- Issue [#1052](https://github.com/midnightntwrk/midnight-js/issues/1052):
  WASM dual-instantiation in Vite monorepo requires resolve.dedupe workaround
- [example-bboard](https://github.com/midnightntwrk/example-bboard):
  official Midnight dApp example with alternative bundler configuration
- [Midnight Private Auction](https://github.com/pplmaverick/midnight-private-auction):
  production dApp on Midnight Mainnet using Option A
