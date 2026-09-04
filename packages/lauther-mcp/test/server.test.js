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

test("it advertises exactly the two tools, with usable descriptions", async () => {
  const api = await fakeLauther(() => ({ body: {} }));
  const client = await connect(api.url);
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["ask_approval", "send_notification"]);

    const ask = tools.find((t) => t.name === "ask_approval");
    assert.match(ask.description, /irreversible/i,
      "the description must tell an agent WHEN to reach for it");
    assert.deepEqual(Object.keys(ask.inputSchema.properties).sort(),
      ["details", "question", "require_biometric", "timeout_seconds"]);
    assert.deepEqual(ask.inputSchema.required, ["question"]);
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
