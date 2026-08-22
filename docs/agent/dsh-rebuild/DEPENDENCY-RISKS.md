# Dependency risk register

## Policy

N36 keeps the M4 monorepo source-only and installs optional BGE dependencies only in the explicit BGE profile. The default profile uses `npm ci --omit=optional` and must have zero high/critical findings. The BGE profile may contain only the advisories registered below, with at most 4 high and 0 critical findings. Any new high/critical advisory fails CI.

No destructive `overrides` are used. A finding disappearing is accepted automatically; changing or adding an advisory requires review rather than replacing one risk with another at the same aggregate count.

## Registered BGE-profile findings

| Package chain | Advisory | Severity/count | Current fix status | Treatment |
|---|---|---:|---|---|
| `@huggingface/transformers → onnxruntime-node → adm-zip` | [GHSA-xcpc-8h2w-3j85](https://github.com/advisories/GHSA-xcpc-8h2w-3j85) | high / 1 | `npm audit` reports no compatible automatic fix | Optional BGE profile only; track upstream |
| `@huggingface/transformers → sharp → libvips` | [GHSA-f88m-g3jw-g9cj](https://github.com/advisories/GHSA-f88m-g3jw-g9cj) | high / 3 | `npm audit` reports no compatible automatic fix | Optional BGE profile only; track upstream |

Baseline captured on 2026-08-15: 4 high / 0 critical in the explicit BGE profile.
