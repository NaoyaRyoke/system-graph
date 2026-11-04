# Source provenance

Code System Graph v1.2.1, upstream commit d161502d8e6db606345f998574df10637591f9e8, Apache-2.0. Vendored core/model/store include local schema/property/provenance hardening. New transport host is a separate crate. Upstream workspace fuzz member omitted for standalone packaging. Source modifications must retain notices and be documented before release.

## Final attribution pass

Changed/added inherited files now carry prominent `Modified from Code System Graph v1.2.1` notices. Original LICENSE/NOTICE and copyright lines are retained. Exact upstream and modified-file hashes are in `licenses/vendor-modifications.json`. The SQL attribution is a single fixed leading comment; all legacy SQL payload bytes are unchanged. Only that exact line is excluded from the schema fingerprint, retaining the previous schema identity while still hashing any other SQL/comment change. Regression tests pin both payload SHA-256 and schema identity. No graph migration, query/ranking, authentication or wire feature is added.


## Optional Terraform/HCL profile

The default read-only host explicitly disables the core terraform feature. Full core keeps its previous default feature for source compatibility; HCL-enabled artifacts remain outside release scope because pratt 0.4.0 license text is unresolved. Original 71 modification records are retained with two additional marked changes (73 total); unmodified upstream fixtures restore reproducible core tests. SQL payload/schema identity and read-only transport contracts are unchanged. See docs/hcl-build-profiles.md.
