# DSH rc.1 compatibility and public-plugin verification

## Change

- Local deepseek-harness was fast-forwarded from `4e84901e6471b79ec0338099867ebb4606d12bb5` to `76fda729799fe9b3848dbe2c211d4b231032b81e`; its master and origin/master match and the checkout is clean. No upstream files were edited, installed, committed, or pushed.
- NovelCraft dsh/client/preset dependencies and the lockfile now pin `0.1.2-rc.1`. The public bundle is prepared as `novelcraft-dsh@0.1.3`; no npm publication, tag, or push was performed.
- The adapted client build vendor follows the same upstream SHA for module externals, CSS forms, and public build-environment substitution. Repository-only build faces remain excluded.
- Default CI now packs the public bundle and installs it into an isolated DSH rc.1 profile before checking Web boot, the served client factory, and authenticated Connection RPC.

## Preserved behavior

The 13 core runtimes remain DSH-free. Tool names, order, schemas, RPC wire, asset schemas, approval semantics, Vault isolation, and CAS/Git transaction behavior are unchanged. Client RPC still cannot write canonical assets.

## Verification

- `npm run check:deps`, `npm run check:distribution`, `npm run check:git-writers`, `npm run check:audit-gate`, `npm run audit:default`, and `git diff --check` passed.
- `npm run build`, `npm run pack:plugin`, and `npm run typecheck` passed.
- `npm test` passed all 16 workspaces. The DSH suite passed 270 tests; the final vendor-specific regression passed both tests after adding CSS/purity coverage.
- A clean temporary DSH `0.1.2-rc.1` installation with pnpm `11.7.0` passed plugin installation, profile composition, token/cookie authentication, Web boot, served client-factory detection, and `/novelcraft/watch/state` RPC. The process was stopped and no real LLM or Vault was used.
- The optional BGE model runtime was not installed or downloaded. Default audit remained high=0 and critical=0.

## Reproduction

Build the tarball with `npm run pack:plugin`. Install DSH rc.1 and pnpm 11.7.0 in a separate runtime, then run `npm run smoke:plugin` with `DSH_BIN` pointing to its CLI, `PLUGIN_TARBALL` pointing to the packed archive, and `DSH_HOME` pointing to a new or empty directory. The script rejects a populated DSH home, bounds startup/HTTP waits, redacts launch tokens, and terminates the child on success or failure.
