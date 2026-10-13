# lauther-client

Push notifications to your phone from any web app or script — and questions
that **wait for a yes** before something irreversible happens.

Zero dependencies. Node 18+.

```bash
npm install lauther-client
```

## Why this exists

A browser tab cannot reach someone who has closed it. Building a native app
per project to fix that is not a plan. Lauther is one app your projects share
over an HTTP call, so any of them can reach a real phone.

## Send a notification

```js
import { Lauther } from "lauther-client";

const lauther = new Lauther(process.env.LAUTHER_TOKEN);

await lauther.push({
  title: "New signup",
  message: "alex@example.com just created an account",
});
```

Get a token in the app: **Apps → ＋ → New token**. It pushes to your phone and
nobody else's, and you can revoke it any time.

## Ask a question and wait for the answer

This is the part that has no equivalent in a normal push service. The call
blocks until you press a button on your phone, then returns what you pressed.

```js
if (await lauther.ask("Deploy v2.4 to production?")) {
  await deploy();
}
```

**Only an explicit Approve returns `true`.** A denial and a timeout both
return `false` — an unanswered question must never read as a yes.

### Waiting longer than 25 seconds

The API long-polls for at most 25 seconds, which suits a shell one-liner and
not a script whose human has wandered off. Pass `timeoutSeconds` and the client
keeps asking about the **same** notification past that, so a ten-minute wait
still puts one question on the phone rather than one every half minute:

```js
const out = await lauther.requestApproval("Restore last night's snapshot?", {
  timeoutSeconds: 600,
  requireBiometric: true,
});
// { id, response: "approve" | "deny" | null, confirmedBy, waitedSeconds }
```

`response: null` means nobody answered. That is a returned outcome rather than
a thrown error, deliberately — throwing invites a `catch` that treats silence
as success.

Useful for anything you would regret doing automatically: a deploy, a refund,
a database restore, or an AI agent about to act on your behalf.

```js
// Demand a fingerprint before the approval counts.
const { response } = await lauther.approve({
  title: "Refund €240 to order #1183?",
  message: "Requested by support agent Kim",
  requireBiometric: true,
  approveTitle: "Refund",
  denyTitle: "Keep",
  wait: 25,
});
// response is "approve", "deny", or null when nobody answered in time.
```

## Requests

A request is an approval whose "yes" carries something back: the person taps
**Share**, the phone does one thing while they watch, and the result rides
home on the answer. Two kinds: where they are, and one picture.

```js
const where = await lauther.requestLocation({
  title: "Share your location so I can find the nearest pharmacy?",
  timeoutSeconds: 300,
});

if (where.response === "approve") {
  const { lat, lng, accuracy, at } = where.result;
}
```

```js
const shot = await lauther.requestPhoto({ title: "Photo of the printer display?" });

if (shot.response === "approve") {
  const { url, bytes, width, height } = shot.result; // a JPEG download link
}
```

Both return `{ id, response, confirmedBy, result, waitedSeconds, expired }`.
`response` is `"approve"`, `"deny"` or `null`, and `result` is `null` unless
the person approved. They wait the way `requestApproval()` does: past the
server's 25 seconds on the **same** request, so the phone still shows one.
Silence is a returned outcome rather than a thrown error. `expired: true`
means the request lapsed on the phone (10 minutes by default; set
`expiresIn`, 60 to 3600 seconds) and the wait ends early.

- **Location** is one reading, taken when they tap Share and sent once:
  `{ lat, lng, accuracy, at }`, with `accuracy` in metres.
- **Photo** is a JPEG they take or pick, at most 2 MB. You receive a link,
  and **the link works for 7 days**; download it if you want to keep it.

Options for both: `title`, `message`, `requireBiometric`, `priority`,
`expiresIn`, plus `timeoutSeconds` and `pollIntervalMs` for the wait. For
full control, `request(kind, options)` is the single call behind them (it
answers within `wait` seconds, 0 to 25), and `poll(id)` also returns `result`
and `expired`.

## Handling failure

```js
import { Lauther, LautherError } from "lauther-client";

try {
  await lauther.push({ title: "Backup finished" });
} catch (err) {
  if (err instanceof LautherError) {
    console.error(err.status, err.code, err.message);
  }
}
```

Branch on `err.code`, never on `err.message` — messages are written for people
and may be reworded. A network failure is reported as unreachable rather than
as a refusal, because those need different handling.

## Knowing whether it arrived

`push()` resolves with what actually happened:

```js
const { delivered, devices } = await lauther.push({ title: "Hello" });
```

`delivered: 0` with `devices: 0` means **no phone is registered** on the
account — usually the app has not been opened since signing in. That is a
different problem from every device rejecting the message, so the two are
reported separately rather than collapsed into one flag.

## API

| | |
| --- | --- |
| `new Lauther(token, options?)` | `options`: `baseUrl`, `fetch`, `timeoutMs` |
| `push(options)` | `title`, `message`, `priority`, `url`, `path`, `tag`, `icon`, `color`, `sound`, `image` |
| `approve(options)` | `title`, `message`, `wait` (0–25s), `approveTitle`, `denyTitle`, `requireBiometric`, `priority` |
| `requestApproval(question, options?)` | Ask and wait, past the 25s cap, on one notification |
| `request(kind, options?)` | Ask for `"location"` or `"photo"`; `title`, `message`, `requireBiometric`, `priority`, `wait`, `expiresIn` |
| `requestLocation(options?)` | Ask for a position and wait, past the 25s cap, on one request |
| `requestPhoto(options?)` | Ask for one picture and wait, past the 25s cap |
| `poll(id)` | Ask about an approval or request already started (carries `result` and `expired`) |
| `ask(question, options?)` | `requestApproval()` reduced to a boolean |

`priority` runs `-2` to `2`. **`2` is the only level that crosses quiet
hours** — worth setting on about three things and no more.

Images require a Supporter account. Without one the image is dropped and the
notification still arrives, because a script should not start failing over an
entitlement.

TypeScript types are bundled; there is no `@types` package to install.

## You do not need this package

The whole client is `fetch` against a few documented endpoints. If you would
rather not add a dependency, this is the entire integration:

```js
await fetch("https://api.lauther.id/v1/push", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.LAUTHER_TOKEN}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ title: "Backup finished" }),
});
```

That is deliberate. A service you can leave in one line has to keep earning
you.

## Worth knowing before you build on it

- **Hosted only.** The relay holds the APNs connection and the identity
  layer, which is the part that cannot meaningfully run on your own box.
- **Not end-to-end encrypted.** Message bodies travel over TLS and are
  readable by the service. Do not route secrets through it.
- **Pushover-compatible.** Tools that let you change the Pushover *server
  URL* work by pointing them at `https://api.lauther.id`, so moving your
  senders elsewhere later is a URL change rather than a rewrite.

## Using this from a coding agent

[`lauther-mcp`](https://www.npmjs.com/package/lauther-mcp) wraps this as an MCP
server, so Claude Code, Cursor or Windsurf can ask you for approval on your
phone before doing something irreversible.

## Links

- Docs — https://lauther.app/docs.html
- The app — [App Store](https://apps.apple.com/app/id6802635695) · [Google Play](https://play.google.com/store/apps/details?id=id.lauther)
- Recipes for curl, Python, Home Assistant, Uptime Kuma, GitHub Actions —
  https://github.com/csanadymiklos/lauther-examples
- Something wrong? **hello@lauther.id** reaches a human.

MIT
