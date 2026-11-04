# Complete OS advisory review

The previous 84 source-package findings are retained individually in [os-advisory-review.json](os-advisory-review.json), with presence, versions, source records, conditions and residual risk. Current distributions: FIXED 57 / NOT AFFECTED 23 / ACCEPTED WITH EVIDENCE 4 / BLOCKER 0 for the exact reviewed Linux AMD64 artifact. Raw Critical 1 / High 8 / Medium 13 / Low 2 / unknown 3 is not rewritten.

The six previous blockers have final per-case evidence in [os-advisory-final.md](os-advisory-final.md) and its JSON record. Do not use the earlier phase's unresolved count as the current artifact decision or interpret this as all package source code being fixed. The final checker binds to actual runtime-manifest SHA-256 and rejects expired/new/mismatched evidence.

Four contextual accepted records retain their preconditions and mitigations (e.g. guard-enforced environment/DNS). All decisions expire immediately on relevant payload/config/API/Node/native changes, and on the recorded review-before date. No arbitrary JS/Wasm/compiler/plugin or graph-write endpoint is permitted by the assessed contract. Unknown severity is reviewed by exploit class, not silently treated as Low.

Rust static SQLite is 3.54.1; Node contains separately inventoried SQLite 3.53.4 but runtime does not import that API. Trusted synthetic generation is a development operation. Official Node security data, exact binary/source identity, npm audit and OSV are complementary; no complete future-vulnerability guarantee is implied. Raw scanner output, contexts and unresolved license gate are all retained separately.
