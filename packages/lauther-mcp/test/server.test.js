/**
 * End-to-end: spawn the real server over stdio, drive it with a real MCP
 * client, and answer it with a fake Lauther API. No mocking of the transport —
 * if the tool schemas or the stdio wiring are wrong, these fail.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "index.js");

/** A stand-in Lauther. `script` decides what each endpoint answers. */
async function fakeLauther(script) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = body ? JSON.parse(body) : {};
      seen.push({ path: req.url, body: parsed, auth: req.headers.authorization });
      const out = script(req.url, parsed, seen);
      if (out.raw) {
        res.writeHead(out.status ?? 200, { "Content-Type": out.type ?? "application/octet-stream" });
        res.end(out.raw);
        return;
      }
      res.writeHead(out.status ?? 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(out.body));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, seen,
    close: () => new Promise((r) => server.close(r)) };
}

async function connect(baseUrl) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [ENTRY],
    env: { ...process.env, LAUTHER_TOKEN: "lpt_test", LAUTHER_BASE_URL: baseUrl },
  });
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

test("it advertises exactly the four tools, with usable descriptions", async () => {
  const api = await fakeLauther(() => ({ body: {} }));
  const client = await connect(api.url);
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(),
      ["ask_approval", "get_location", "request_photo", "send_notification"]);

    const ask = tools.find((t) => t.name === "ask_approval");
    assert.match(ask.description, /irreversible/i,
      "the description must tell an agent WHEN to reach for it");
    assert.deepEqual(Object.keys(ask.inputSchema.properties).sort(),
      ["details", "question", "require_biometric", "timeout_seconds"]);
    assert.deepEqual(ask.inputSchema.required, ["question"]);

    for (const name of ["get_location", "request_photo"]) {
      const t = tools.find((x) => x.name === name);
      assert.deepEqual(Object.keys(t.inputSchema.properties).sort(),
        ["details", "question", "require_biometric", "timeout_seconds"]);
      assert.ok(!t.inputSchema.required?.length, `${name}: every input is optional`);
    }
  } finally {
    await client.close();
    await api.close();
  }
});

test("an approval comes back as APPROVED and carries the biometric confirmation", async () => {
  const api = await fakeLauther((url) =>
    url === "/v1/approve"
      ? { body: { ok: true, id: "n1", response: "approve", confirmedBy: "biometric" } }
      : { body: {} });
  const client = await connect(api.url);
  try {
    const r = await client.callTool({
      name: "ask_approval",
      arguments: { question: "Deploy v2.4?", require_biometric: true },
    });
    assert.match(r.content[0].text, /^APPROVED/);
    assert.match(r.content[0].text, /biometric/);
    assert.equal(api.seen[0].auth, "Bearer lpt_test");
    assert.equal(api.seen[0].body.requireBiometric, true);
  } finally {
    await client.close();
    await api.close();
  }
});

test("a denial says stop, and does not invite a retry", async () => {
  const api = await fakeLauther((url) =>
    url === "/v1/approve" ? { body: { ok: true, id: "n1", response: "deny" } } : { body: {} });
  const client = await connect(api.url);
  try {
    const r = await client.callTool({
      name: "ask_approval", arguments: { question: "Delete the bucket?" },
    });
    assert.match(r.content[0].text, /^DENIED/);
    assert.match(r.content[0].text, /Do not proceed/);
    assert.match(r.content[0].text, /do not look for another way/i);
  } finally {
    await client.close();
    await api.close();
  }
});

test("silence is reported as NO ANSWER and never as approval", async () => {
  const api = await fakeLauther((url) =>
    url === "/v1/approve"
      ? { body: { ok: true, id: "n1", response: null } }
      : { body: { response: null, confirmedBy: null } });
  const client = await connect(api.url);
  try {
    const r = await client.callTool({
      name: "ask_approval",
      arguments: { question: "Wipe staging?", timeout_seconds: 5 },
    });
    assert.match(r.content[0].text, /^NO ANSWER/);
    assert.match(r.content[0].text, /silence is not consent/i);
    assert.ok(!/APPROVED/.test(r.content[0].text));
    const approves = api.seen.filter((s) => s.path === "/v1/approve");
    assert.equal(approves.length, 1, "one question on the phone, however long the wait");
  } finally {
    await client.close();
    await api.close();
  }
});

test("a push with no registered device says so instead of claiming success", async () => {
  const api = await fakeLauther(() => ({ body: { ok: true, id: "n1", delivered: 0, devices: 0 } }));
  const client = await connect(api.url);
  try {
    const r = await client.callTool({
      name: "send_notification", arguments: { title: "Build finished" },
    });
    assert.match(r.content[0].text, /NO DEVICE is registered/);
  } finally {
    await client.close();
    await api.close();
  }
});

test("urgent maps to the priority that crosses quiet hours", async () => {
  const api = await fakeLauther(() => ({ body: { ok: true, id: "n1", delivered: 1, devices: 1 } }));
  const client = await connect(api.url);
  try {
    const r = await client.callTool({
      name: "send_notification",
      arguments: { title: "UPS on battery", priority: "urgent" },
    });
    assert.match(r.content[0].text, /delivered to 1 of 1/);
    assert.equal(api.seen[0].body.priority, 2);
  } finally {
    await client.close();
    await api.close();
  }
});

test("a rejected token is explained, and still refuses to proceed", async () => {
  const api = await fakeLauther(() => ({ status: 403, body: { error: "Invalid or revoked token" } }));
  const client = await connect(api.url);
  try {
    const r = await client.callTool({
      name: "ask_approval", arguments: { question: "Ship it?" },
    });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /rejected the token \(HTTP 403\)/);
    assert.match(r.content[0].text, /do not proceed/i);
  } finally {
    await client.close();
    await api.close();
  }
});

// --- requests: location and photo ------------------------------------------

const FIX = { lat: 47.4979, lng: 19.0402, accuracy: 12.5, at: "2026-10-13T09:00:00.000Z" };

test("get_location reports the position, accuracy and how it was confirmed", async () => {
  const api = await fakeLauther((url) =>
    url === "/v1/request"
      ? { body: { ok: true, id: "r1", response: "approve", confirmedBy: "biometric", result: FIX } }
      : { body: {} });
  const client = await connect(api.url);
  try {
    const r = await client.callTool({
      name: "get_location",
      arguments: { question: "Share your location so I can find a pharmacy?", require_biometric: true },
    });
    assert.match(r.content[0].text,
      /^SHARED after \d+s: 47\.4979, 19\.0402 \(±13 m\) at 2026-10-13T09:00:00Z\. Confirmed by biometric\./);
    assert.equal(api.seen[0].path, "/v1/request");
    assert.equal(api.seen[0].auth, "Bearer lpt_test");
    assert.equal(api.seen[0].body.kind, "location");
    assert.equal(api.seen[0].body.title, "Share your location so I can find a pharmacy?");
    assert.equal(api.seen[0].body.requireBiometric, true);
  } finally {
    await client.close();
    await api.close();
  }
});

test("get_location asks the default question when none is given", async () => {
  const api = await fakeLauther(() =>
    ({ body: { ok: true, id: "r1", response: "approve", result: { lat: 1, lng: 2 } } }));
  const client = await connect(api.url);
  try {
    const r = await client.callTool({ name: "get_location", arguments: {} });
    assert.match(r.content[0].text, /^SHARED after \d+s: 1\.0000, 2\.0000\./);
    assert.ok(!/±/.test(r.content[0].text), "no accuracy given, none invented");
    assert.equal(api.seen[0].body.title, "Share your location?");
  } finally {
    await client.close();
    await api.close();
  }
});

test("a declined location says stop, and does not invite a retry", async () => {
  const api = await fakeLauther(() =>
    ({ body: { ok: true, id: "r1", response: "deny", result: null } }));
  const client = await connect(api.url);
  try {
    const r = await client.callTool({ name: "get_location", arguments: {} });
    assert.match(r.content[0].text, /^DECLINED after \d+s\. Do not retry/);
    assert.ok(!/SHARED/.test(r.content[0].text));
  } finally {
    await client.close();
    await api.close();
  }
});

test("an expired location request is reported as EXPIRED, never as shared", async () => {
  const api = await fakeLauther((url) =>
    url === "/v1/request"
      ? { body: { ok: true, id: "r1", response: null, result: null } }
      : { body: { response: null, confirmedBy: null, result: null, expired: true } });
  const client = await connect(api.url);
  try {
    const r = await client.callTool({
      name: "get_location", arguments: { timeout_seconds: 60 },
    });
    assert.match(r.content[0].text, /^EXPIRED after \d+s/);
    assert.ok(!/SHARED/.test(r.content[0].text));
    assert.equal(api.seen.filter((s) => s.path === "/v1/request").length, 1);
  } finally {
    await client.close();
    await api.close();
  }
});

test("request_photo returns the link and the picture as an image block", async () => {
  // Starts with the JPEG magic bytes; the server never decodes it.
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);
  const api = await fakeLauther((url) => {
    if (url === "/v1/request") {
      return { body: { ok: true, id: "r2", response: "approve", confirmedBy: "biometric",
        result: { url: `${api.url}/shared/r2.jpg`, bytes: jpeg.length, width: 1600, height: 1200 } } };
    }
    if (url === "/shared/r2.jpg") return { raw: jpeg, type: "image/jpeg" };
    return { body: {} };
  });
  const client = await connect(api.url);
  try {
    const r = await client.callTool({
      name: "request_photo", arguments: { question: "Photo of the printer display?" },
    });
    assert.equal(api.seen[0].body.kind, "photo");
    assert.equal(api.seen[0].body.title, "Photo of the printer display?");
    assert.equal(r.content.length, 2);
    assert.equal(r.content[0].type, "text");
    assert.match(r.content[0].text, /^SHARED after \d+s: photo 1600x1200 at http:\/\/127\.0\.0\.1:\d+\/shared\/r2\.jpg/);
    assert.match(r.content[0].text, /available for 7 days/);
    assert.match(r.content[0].text, /Confirmed by biometric/);
    assert.equal(r.content[1].type, "image");
    assert.equal(r.content[1].mimeType, "image/jpeg");
    assert.equal(r.content[1].data, jpeg.toString("base64"));
  } finally {
    await client.close();
    await api.close();
  }
});

test("request_photo falls back to text when the picture cannot be fetched", async () => {
  const api = await fakeLauther((url) => {
    if (url === "/v1/request") {
      return { body: { ok: true, id: "r2", response: "approve",
        result: { url: `${api.url}/shared/gone.jpg`, bytes: 10 } } };
    }
    return { status: 404, body: { error: "gone" } };
  });
  const client = await connect(api.url);
  try {
    const r = await client.callTool({ name: "request_photo", arguments: {} });
    assert.equal(api.seen[0].body.title, "Take a photo?");
    assert.equal(r.content.length, 1, "no image block when the fetch fails");
    assert.match(r.content[0].text, /^SHARED after \d+s: photo at /);
    assert.match(r.content[0].text, /available for 7 days/);
    assert.match(r.content[0].text, /could not be fetched/);
    assert.ok(!r.isError);
  } finally {
    await client.close();
    await api.close();
  }
});

test("a declined photo says stop", async () => {
  const api = await fakeLauther(() =>
    ({ body: { ok: true, id: "r2", response: "deny", result: null } }));
  const client = await connect(api.url);
  try {
    const r = await client.callTool({ name: "request_photo", arguments: {} });
    assert.equal(r.content.length, 1);
    assert.match(r.content[0].text, /^DECLINED after \d+s\. Do not retry/);
  } finally {
    await client.close();
    await api.close();
  }
});
