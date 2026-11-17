import { chmodSync, cpSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"

import packageJson from "../package.json"
import { SKIPPED_ASSETS } from "./static"

// Builds the npm package `@ta3/cardinal` into server/npm/: the Node server
// (server/node.ts, bundled with its dependencies) and the built app in ./app.
//
//   bun run build && bun server/npm.ts      then: cd server/npm && npm publish --access public

const root = path.resolve(import.meta.dir, "..")
const client = path.join(root, "dist/client")
const out = path.join(import.meta.dir, "npm")
const version = process.env.CARDINAL_VERSION?.replace(/^v/, "") || packageJson.version

if (!statSync(path.join(client, "index.html"), { throwIfNoEntry: false })) {
  throw new Error("dist/client/index.html is missing; run `bun run build` first")
}
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

const result = await Bun.build({
  entrypoints: [path.join(import.meta.dir, "node.ts")],
  outdir: out,
  naming: "cardinal.mjs",
  target: "node",
  format: "esm",
  minify: true,
  banner: "#!/usr/bin/env node",
  define: { CARDINAL_VERSION: JSON.stringify(version) },
})
if (!result.success) {
  for (const log of result.logs) console.error(log)
  throw new Error("Build failed")
}
chmodSync(path.join(out, "cardinal.mjs"), 0o755)

cpSync(client, path.join(out, "app"), {
  recursive: true,
  filter: (source) => !SKIPPED_ASSETS.has(`/${path.relative(client, source).split(path.sep).join("/")}`),
})

writeFileSync(
  path.join(out, "package.json"),
  `${JSON.stringify(
    {
      name: "@ta3/cardinal",
      version,
      description: "Find and cut cardinality in Prometheus and Loki, on your own machine: your credentials and queries never leave it.",
      keywords: ["prometheus", "loki", "grafana", "cardinality", "observability", "mimir"],
      homepage: "https://cardinal.ta3.dev",
      repository: { type: "git", url: "git+https://github.com/TA3/cardinal.git" },
      license: "AGPL-3.0-only",
      type: "module",
      bin: { cardinal: "cardinal.mjs" },
      files: ["cardinal.mjs", "app", "LICENSE"],
      engines: { node: ">=20" },
    },
    null,
    2
  )}\n`
)

cpSync(path.join(root, "LICENSE"), path.join(out, "LICENSE"))

writeFileSync(
  path.join(out, "README.md"),
  `# Cardinal

Find and cut cardinality in Prometheus and Loki. This package runs the whole app and its proxy on your machine,
so Prometheus, Loki and Grafana on your network work without CORS, and your credentials and queries never reach
a Cardinal server.

\`\`\`bash
npx @ta3/cardinal          # then open http://localhost:9181
\`\`\`

It listens on 127.0.0.1 only. Run \`npx @ta3/cardinal --help\` for options. Needs Node 20 or later.

More: https://github.com/TA3/cardinal

License: AGPL-3.0-only (see LICENSE).
`
)

console.log(`Built @ta3/cardinal ${version} in ${path.relative(root, out)}/`)
