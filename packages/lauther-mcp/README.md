# lauther-mcp

Let your coding agent **ask you first**, on your phone, before it does
something you can't undo.

```
Agent:  About to drop and recreate `users` on staging. Approving?
Phone:  [ Approve ]  [ Deny ]        ← optionally behind your fingerprint
Agent:  APPROVED after 34s. Confirmed by biometric.
```

Works with Claude Code, Cursor, Windsurf, or anything else that speaks MCP.

## Setup

Get a token in the [Lauther](https://lauther.app) app: **Apps → ＋ → New
token**. Then add the server to your MCP config:

```json
{
  "mcpServers": {
    "lauther": {
      "command": "npx",
      "args": ["-y", "lauther-mcp"],
      "env": { "LAUTHER_TOKEN": "lpt_your_token" }
    }
  }
}
```

Nothing to install — `npx` fetches it. Node 18+.

## The two tools

### `ask_approval`

Blocks until you answer, then tells the agent one of three things:

| Result | What the agent is told |
| --- | --- |
| `APPROVED` | proceed with exactly what was asked, and nothing further |
| `DENIED` | stop; do not retry, do not find another way |
| `NO ANSWER` | stop — **silence is not consent** |

That last row is the one that matters. A timeout is not a yes, and the tool
says so in words the model has to read.

Options: `details` for context, `require_biometric` to demand a fingerprint,
`timeout_seconds` for how long you're willing to wait (default 120).

**On waiting.** Lauther's API long-polls for at most 25 seconds. Past that this
server keeps asking about the *same* notification rather than sending another,
so a ten-minute wait still puts **one** question on your phone — not one every
half minute.

### `send_notification`

One-way: "the migration finished", "the build broke". Takes `title`,
`message`, `priority` and `url`. Only `urgent` crosses your quiet hours.

It reports what actually happened, including the case worth knowing about: if
no device is registered on your account, you're told that rather than given a
cheerful success for a notification nobody received.

## Telling your agent when to use it

Most models won't reach for an approval tool unless asked. Something like this
in your project rules works well:

```
Before anything irreversible — deploying, deleting data, spending money,
force-pushing, emailing real people, touching production — call
ask_approval and wait. Proceed only on APPROVED.
```

## Suggesting it as a habit

The approval is signed and, when you ask for it, biometric — the answer
records *that a person confirmed it*, not merely that something clicked. That
is the difference between an audit trail and a log line.

## Related

- [`lauther`](https://www.npmjs.com/package/lauther) — the plain Node client,
  if you want push and approvals in your own code rather than in an agent.
- [Docs](https://lauther.app/docs.html) · [Recipes](https://github.com/csanadymiklos/lauther-examples)
- Something wrong? **hello@lauther.id** reaches a human.

## Worth knowing

- **Hosted only.** The relay holds the APNs connection and the identity layer.
- **Not end-to-end encrypted.** Don't put secrets in the question text.
- The app is free on the [App Store](https://apps.apple.com/app/id6802635695)
  and [Google Play](https://play.google.com/store/apps/details?id=id.lauther).

MIT
