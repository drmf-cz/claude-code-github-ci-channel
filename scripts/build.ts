#!/usr/bin/env bun
/**
 * Build script — bundles all entry points for npm distribution.
 *
 * Output:
 *   dist/index.js   — standalone MCP server (stdio, one session)
 *   dist/mux.js     — mux server (HTTP, multi-session)
 *
 * Each output file gets a #!/usr/bin/env bun shebang and is chmod +x'd
 * so it can be used directly as a bin entry in package.json.
 */

import { chmodSync } from "node:fs";
import { $ } from "bun";

const entries: Array<{ src: string; out: string }> = [
  { src: "src/index.ts", out: "dist/index.js" },
  { src: "src/mux.ts", out: "dist/mux.js" },
];

for (const { src, out } of entries) {
  await $`bun build ${src} --outfile ${out} --target bun --minify`.quiet();

  const content = await Bun.file(out).text();
  await Bun.write(out, `#!/usr/bin/env bun\n${content}`);
  chmodSync(out, 0o755);

  console.log(`Built ${src} → ${out}`);
}

console.log("Done.");
