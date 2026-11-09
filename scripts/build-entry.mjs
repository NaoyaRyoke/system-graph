// Preserve dist/src and dist/tests compatibility while providing the standard MCP command.
import { writeFileSync } from 'node:fs';
writeFileSync(new URL('../dist/index.js', import.meta.url), "#!/usr/bin/env node\nimport './src/index.js';\n", { mode: 0o755 });
