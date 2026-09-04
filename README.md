# lauther-js

JavaScript packages for [Lauther](https://lauther.app) — push notifications to
your phone from any web app or script, and questions that **wait for a yes**
before something irreversible happens.

| Package | What it is |
| --- | --- |
| [`lauther-client`](packages/lauther-client) | The Node client. Zero dependencies, two methods, TypeScript types bundled. |
| [`lauther-mcp`](packages/lauther-mcp) | An MCP server, so a coding agent can ask its owner for approval on their phone. |

```bash
npm install lauther-client
```

```js
import { Lauther } from "lauther-client";

const lauther = new Lauther(process.env.LAUTHER_TOKEN);

await lauther.push({ title: "Backup finished" });

if (await lauther.ask("Deploy v2.4 to production?")) {
  await deploy();
}
```

**Only an explicit Approve returns `true`.** A denial and a timeout are both
`false` — an unanswered question must never read as a yes.

## Why this exists

A browser tab can't reach someone who closed it, and building a native app per
project to fix that was never going to happen. Lauther is one app your projects
share over an HTTP call.

## Development

Node 18+. npm workspaces, no build step, no bundler.

```bash
npm install
npm test          # both packages
```

`lauther-client` has no runtime dependencies and is tested with a stubbed `fetch`.
`lauther-mcp` is tested by spawning the real server over stdio and driving it
with a real MCP client against a fake Lauther API — so a broken tool schema or
broken stdio wiring fails the suite rather than a user's agent.

## Links

- [lauther.app](https://lauther.app) · [Docs](https://lauther.app/docs.html)
- [Recipes](https://github.com/csanadymiklos/lauther-examples) for curl,
  Python, Home Assistant, Uptime Kuma and GitHub Actions
- The app: [App Store](https://apps.apple.com/app/id6802635695) ·
  [Google Play](https://play.google.com/store/apps/details?id=id.lauther)
- **hello@lauther.id** reaches a human.

MIT
