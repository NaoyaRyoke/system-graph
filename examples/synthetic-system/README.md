# Synthetic system

All names, claims and records are synthetic. `sample_graph` is an operator-only generator using native model/store snapshot publication; it is not a remote tool or inferred runtime scan. Its source is rust-host/src/bin/sample_graph.rs. `npm run sample` generates the data and keeps DBs outside release source.

For each dev/staging/production environment: sample-web consumes sample-api; sample-api reads sample-db; sample-web calls sample-auth; sample-worker writes sample-db and publishes sample-events; sample-api subscribes to sample-events. Each component has a distinct repository ID, environment-aware identity, reader/writer assertions, declared provenance and synthetic deployment metadata. Production reader permissions exclude dev/staging by default. A sample writer node does not imply that this MCP server can write.

The compatibility regression fixture separately uses two tenants with the same workspace/service/environment names. The scaled graph has 10k nodes/50k cyclic edges and explicit resource caps. No real code, user, hostname or provider credential is used.
