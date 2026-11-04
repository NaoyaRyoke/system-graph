# HCL-free public build profile

Version: **0.1.0-beta.1**. Only the read-only host is a public beta artifact. Terraform/HCL-enabled full-core builds are not cleared for redistribution because an applicable pratt 0.4.0 license body has not been established.

The core retains `terraform = ["dep:hcl-rs"]` and its compatibility default. `rust-host` uses core with `default-features = false`. The public active dependency closure excludes pratt, hcl-edit and hcl-rs. Optional entries in the full-core Cargo.lock describe possible resolution, not included source implementations or linked code.

```sh
cargo build --manifest-path rust-host/Cargo.toml --locked --release
cargo tree --manifest-path rust-host/Cargo.toml --locked --edges normal,build,features
```

HCL-disabled extraction returns `InfrastructureExtractionError::TerraformDisabled` with `Terraform/HCL extraction is disabled in this build (terraform feature)`. It does not parse or echo input. Compose/Kubernetes/Helm extraction and existing graph enum compatibility remain. MCP exposes no source scanning/upload/write endpoint.

Distribution inventory follows active normal/build dependencies, rejects HCL feature unification and fails closed on incomplete dependency metadata. Lockfiles alone, binary strings alone or a declared SPDX license alone do not prove an artifact's redistributability.

Keep the project/vendor/dependency LICENSE/NOTICE files and the full modification manifest. Existing SQL schema identity and the fixed attribution comment are preserved. Do not publish a standalone binary without its accompanying notices/native source obligations. Native ARM64, Windows MSVC and long soak remain acceptance limitations.
