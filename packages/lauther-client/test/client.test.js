import {test} from "node:test";
import assert from "node:assert/strict";
import {Lauther, LautherError} from "../src/index.js";

/** A fetch stand-in that records the call and replays a canned response. */
function stubFetch(response, {status = 200} = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({url, init, body: JSON.parse(init.body)});
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(response),
    };
  };
  fn.calls = calls;
  return fn;
}

test("push sends the token as a bearer and posts to /v1/push", async () => {
  const fetch = stubFetch({ok: true, id: "n1", delivered: 1, devices: 1});
  const out = await new Lauther("lpt_test", {fetch}).push({title: "Hi"});

  assert.equal(fetch.calls[0].url, "https://api.lauther.id/v1/push");
  assert.equal(fetch.calls[0].init.headers.Authorization, "Bearer lpt_test");
  assert.deepEqual(fetch.calls[0].body, {title: "Hi"});
  assert.equal(out.delivered, 1);
});

test("undefined fields are dropped rather than serialised as null", async () => {
  const fetch = stubFetch({ok: true});
  await new Lauther("lpt_test", {fetch})
      .push({title: "Hi", message: undefined, priority: undefined});
  assert.deepEqual(fetch.calls[0].body, {title: "Hi"});
});

test("push refuses a call with neither title nor message", async () => {
  const fetch = stubFetch({ok: true});
  await assert.rejects(
      () => new Lauther("lpt_test", {fetch}).push({}),
      (e) => e instanceof LautherError && /title or a message/.test(e.message));
  assert.equal(fetch.calls.length, 0, "must not hit the network");
});

test("wait is clamped to the server's own 25s ceiling", async () => {
  const fetch = stubFetch({ok: true, id: "a1", response: "approve"});
  const l = new Lauther("lpt_test", {fetch});
  await l.approve({title: "Deploy?", wait: 600});
  assert.equal(fetch.calls[0].body.wait, 25);
  await l.approve({title: "Deploy?", wait: -5});
  assert.equal(fetch.calls[1].body.wait, 0);
});

test("ask() is true ONLY on an explicit approve", async () => {
  for (const [response, expected] of [
    ["approve", true], ["deny", false], [null, false],
  ]) {
    const fetch = stubFetch({ok: true, id: "a1", response});
    const got = await new Lauther("lpt_test", {fetch}).ask("Ship it?");
    assert.equal(got, expected, `response ${JSON.stringify(response)}`);
  }
});

test("an API error surfaces status, code and the human message", async () => {
  const fetch = stubFetch(
      {error: "The free tier holds 5 disposable addresses at a time.",
        code: "alias_limit_reached"},
      {status: 403});
  await assert.rejects(
      () => new Lauther("lpt_test", {fetch}).push({title: "x"}),
      (e) => {
        assert.ok(e instanceof LautherError);
        assert.equal(e.status, 403);
        assert.equal(e.code, "alias_limit_reached");
        assert.match(e.message, /free tier holds 5/);
        return true;
      });
});

test("a network failure is reported as unreachable, never as a denial", async () => {
  const fetch = async () => {
    throw new Error("connect ECONNREFUSED");
  };
  await assert.rejects(
      () => new Lauther("lpt_test", {fetch}).ask("Ship it?"),
      (e) => e instanceof LautherError && /Could not reach Lauther/.test(e.message));
});

test("a missing token fails at construction, not at send time", () => {
  assert.throws(() => new Lauther(""), LautherError);
  assert.throws(() => new Lauther(undefined), LautherError);
});

test("baseUrl override drops a trailing slash", async () => {
  const fetch = stubFetch({ok: true});
  await new Lauther("lpt_test", {fetch, baseUrl: "http://localhost:5111/"})
      .push({title: "Hi"});
  assert.equal(fetch.calls[0].url, "http://localhost:5111/v1/push");
});

// --- waiting past the server's 25s cap -------------------------------------

/** Routes by path so an approve + a series of polls can be scripted. */
function routedFetch(routes) {
  const calls = [];
  const fn = async (url, init) => {
    const path = new URL(url).pathname;
    calls.push({ path, body: JSON.parse(init.body) });
    const handler = routes[path];
    const payload = typeof handler === "function" ? handler(calls) : handler;
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
  };
  fn.calls = calls;
  return fn;
}

test("requestApproval returns straight away when the long-poll already answered", async () => {
  const fetch = routedFetch({
    "/v1/approve": { ok: true, id: "n1", response: "approve" },
  });
  const out = await new Lauther("lpt_test", { fetch }).requestApproval("Ship it?");
  assert.equal(out.response, "approve");
  assert.equal(fetch.calls.length, 1, "must not poll when it already knows");
});

test("it polls past 25s and NEVER sends a second notification", async () => {
  let polls = 0;
  const fetch = routedFetch({
    "/v1/approve": { ok: true, id: "n1", response: null },
    "/v1/action/poll": () => {
      polls += 1;
      return polls < 3
        ? { response: null, confirmedBy: null }
        : { response: "approve", confirmedBy: "biometric" };
    },
  });
  const out = await new Lauther("lpt_test", { fetch })
      .requestApproval("Deploy?", { timeoutSeconds: 60, pollIntervalMs: 1 });

  assert.equal(out.response, "approve");
  assert.equal(out.confirmedBy, "biometric", "biometric confirmation must survive");
  const approves = fetch.calls.filter(c => c.path === "/v1/approve");
  assert.equal(approves.length, 1, "one question on the phone, not a pile");
  assert.equal(approves[0].body.wait, 25, "first call still uses the server wait");
  assert.ok(fetch.calls.every(c => c.path !== "/v1/approve" || c.body.title === "Deploy?"));
});

test("poll carries the token in the body, which is what that endpoint wants", async () => {
  const fetch = routedFetch({ "/v1/action/poll": { response: null, confirmedBy: null } });
  await new Lauther("lpt_test", { fetch }).poll("n1");
  assert.deepEqual(fetch.calls[0].body, { token: "lpt_test", id: "n1" });
});

test("nobody answering is an outcome, not an exception - and never a yes", async () => {
  const fetch = routedFetch({
    "/v1/approve": { ok: true, id: "n1", response: null },
    "/v1/action/poll": { response: null, confirmedBy: null },
  });
  const l = new Lauther("lpt_test", { fetch });
  const out = await l.requestApproval("Drop the table?", { timeoutSeconds: 0.05, pollIntervalMs: 1 });
  assert.equal(out.response, null);
  assert.equal(await l.ask("Drop the table?", { timeoutSeconds: 0.05, pollIntervalMs: 1 }), false);
});

// --- requests: location and photo ------------------------------------------

const FIX = { lat: 47.4979, lng: 19.0402, accuracy: 12.5, at: "2026-10-13T09:00:00.000Z" };

test("request() posts the kind with the bearer token and caps wait at 25", async () => {
  const fetch = routedFetch({
    "/v1/request": { ok: true, id: "r1", response: null, result: null },
  });
  const out = await new Lauther("lpt_test", { fetch }).request("location", {
    title: "Where are you?", requireBiometric: true, expiresIn: 120, wait: 99,
  });
  assert.equal(out.id, "r1");
  assert.deepEqual(fetch.calls[0].body, {
    kind: "location", title: "Where are you?", requireBiometric: true,
    expiresIn: 120, wait: 25,
  });
  assert.equal(fetch.calls[0].path, "/v1/request");
});

test("request() needs a kind", async () => {
  const l = new Lauther("lpt_test", { fetch: routedFetch({}) });
  await assert.rejects(() => l.request(), LautherError);
});

test("request() surfaces the API's code, e.g. unknown_kind", async () => {
  const fetch = async () => ({
    ok: false, status: 400,
    text: async () => JSON.stringify({ error: "Unknown kind", code: "unknown_kind" }),
  });
  await assert.rejects(
    () => new Lauther("lpt_test", { fetch }).request("voice"),
    (e) => e instanceof LautherError && e.status === 400 && e.code === "unknown_kind");
});

test("poll passes result and expired through", async () => {
  const fetch = routedFetch({
    "/v1/action/poll": { response: "approve", confirmedBy: null, result: FIX, expired: false },
  });
  const out = await new Lauther("lpt_test", { fetch }).poll("r1");
  assert.deepEqual(out.result, FIX);
  assert.equal(out.expired, false);
});

test("requestLocation returns straight away when the long-poll already answered", async () => {
  const fetch = routedFetch({
    "/v1/request": { ok: true, id: "r1", response: "approve", result: FIX },
  });
  const out = await new Lauther("lpt_test", { fetch }).requestLocation();
  assert.equal(out.response, "approve");
  assert.deepEqual(out.result, FIX);
  assert.equal(out.expired, false);
  assert.equal(out.confirmedBy, null);
  assert.equal(fetch.calls.length, 1, "must not poll when it already knows");
  assert.equal(fetch.calls[0].body.kind, "location");
});

test("requestLocation polls past 25s on ONE request and returns the result", async () => {
  let polls = 0;
  const fetch = routedFetch({
    "/v1/request": { ok: true, id: "r1", response: null, result: null },
    "/v1/action/poll": () => {
      polls += 1;
      return polls < 3
        ? { response: null, confirmedBy: null, result: null }
        : { response: "approve", confirmedBy: "biometric", result: FIX };
    },
  });
  const out = await new Lauther("lpt_test", { fetch })
      .requestLocation({ timeoutSeconds: 60, pollIntervalMs: 1, title: "Where?" });
  assert.equal(out.response, "approve");
  assert.equal(out.confirmedBy, "biometric");
  assert.deepEqual(out.result, FIX);
  const starts = fetch.calls.filter(c => c.path === "/v1/request");
  assert.equal(starts.length, 1, "one request on the phone, not a pile");
  assert.equal(starts[0].body.wait, 25);
  assert.equal(starts[0].body.title, "Where?");
  assert.equal(starts[0].body.timeoutSeconds, undefined, "client-only options stay client-side");
});

test("requestPhoto sends kind photo and hands back the photo result", async () => {
  const photo = { url: "https://example.test/p.jpg", bytes: 1234, width: 1600, height: 1200 };
  const fetch = routedFetch({
    "/v1/request": { ok: true, id: "r2", response: null, result: null },
    "/v1/action/poll": { response: "approve", confirmedBy: null, result: photo },
  });
  const out = await new Lauther("lpt_test", { fetch })
      .requestPhoto({ timeoutSeconds: 60, pollIntervalMs: 1 });
  assert.equal(fetch.calls[0].body.kind, "photo");
  assert.deepEqual(out.result, photo);
});

test("a denial carries no result", async () => {
  const fetch = routedFetch({
    "/v1/request": { ok: true, id: "r1", response: null, result: null },
    "/v1/action/poll": { response: "deny", confirmedBy: null, result: null },
  });
  const out = await new Lauther("lpt_test", { fetch })
      .requestLocation({ timeoutSeconds: 60, pollIntervalMs: 1 });
  assert.equal(out.response, "deny");
  assert.equal(out.result, null);
});

test("an expired request stops the wait early and says so", async () => {
  let polls = 0;
  const fetch = routedFetch({
    "/v1/request": { ok: true, id: "r1", response: null, result: null },
    "/v1/action/poll": () => {
      polls += 1;
      return { response: null, confirmedBy: null, result: null, expired: true };
    },
  });
  const out = await new Lauther("lpt_test", { fetch })
      .requestLocation({ timeoutSeconds: 600, pollIntervalMs: 1 });
  assert.equal(out.response, null);
  assert.equal(out.expired, true);
  assert.equal(out.result, null);
  assert.equal(polls, 1, "no point polling a dead request");
});

test("nobody answering a request is an outcome, not an exception", async () => {
  const fetch = routedFetch({
    "/v1/request": { ok: true, id: "r1", response: null, result: null },
    "/v1/action/poll": { response: null, confirmedBy: null, result: null },
  });
  const out = await new Lauther("lpt_test", { fetch })
      .requestPhoto({ timeoutSeconds: 0.05, pollIntervalMs: 1 });
  assert.equal(out.response, null);
  assert.equal(out.result, null);
  assert.equal(out.expired, false);
});
