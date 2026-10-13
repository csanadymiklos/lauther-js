/**
 * Lauther — push notifications and human approvals for anything that can make
 * an HTTP request.
 *
 * Zero dependencies on purpose. The whole client is `fetch` against a few
 * documented endpoints, so there is no SDK to go stale against the API and
 * nothing to audit before you install it. If this package ever disappears,
 * the four lines it replaces are in the README.
 *
 * @see https://lauther.app/docs.html
 */

const DEFAULT_BASE_URL = "https://api.lauther.id";

/** The server caps its own wait at 25s; going higher just idles the socket. */
const MAX_WAIT_SECONDS = 25;

/**
 * An error carrying what the API actually said.
 *
 * `code` is the machine-readable reason where the API supplies one (for
 * example `alias_limit_reached`, `cross_origin_path`). Branch on `code`,
 * never on `message` — messages are written for people and may be reworded.
 */
export class LautherError extends Error {
  /**
   * @param {string} message
   * @param {{status?: number, code?: string, body?: unknown}} [detail]
   */
  constructor(message, detail = {}) {
    super(message);
    this.name = "LautherError";
    this.status = detail.status;
    this.code = detail.code;
    this.body = detail.body;
  }
}

/**
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
const isObject = (v) => typeof v === "object" && v !== null;

/** Drop undefined so we never send `"title": undefined` and confuse a proxy. */
const compact = (obj) => {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out;
};

export class Lauther {
  /**
   * @param {string} token Your `lpt_…` token. In the app: Apps → ＋ → New token.
   * @param {{baseUrl?: string, fetch?: typeof globalThis.fetch, timeoutMs?: number}} [options]
   */
  constructor(token, options = {}) {
    if (!token || typeof token !== "string") {
      throw new LautherError(
        "A Lauther token is required. Mint one in the app under " +
        "Apps → ＋ → New token, then pass it as new Lauther(token).");
    }
    this.token = token;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 40_000;
    // Captured rather than looked up per call so tests can inject one, and so
    // a caller who polyfills after construction gets predictable behaviour.
    this._fetch = options.fetch ?? globalThis.fetch;
    if (typeof this._fetch !== "function") {
      throw new LautherError(
        "No fetch available. Node 18+ has it built in; on older runtimes " +
        "pass one: new Lauther(token, { fetch }).");
    }
  }

  /**
   * Send a notification. Resolves once Lauther has accepted it.
   *
   * Note `delivered` in the result: it counts devices that actually took the
   * message. `delivered: 0` with `devices: 0` means no phone is registered on
   * the account — usually the app has not been opened since signing in — and
   * is not the same failure as every device rejecting it.
   *
   * @param {import("./index.d.ts").PushOptions} options
   */
  async push(options) {
    const {title, message, ...rest} = options ?? {};
    if (!title && !message) {
      throw new LautherError("push() needs a title or a message.");
    }
    return this.#request("/v1/push", {title, message, ...rest});
  }

  /**
   * Put Approve / Deny on your phone and wait for the answer.
   *
   * The request blocks server-side for up to 25 seconds. `response` is
   * `"approve"`, `"deny"`, or `null` when nobody answered in time — three
   * outcomes, and silence is not consent.
   *
   * @param {import("./index.d.ts").ApproveOptions} options
   */
  async approve(options) {
    const {title, wait = MAX_WAIT_SECONDS, ...rest} = options ?? {};
    if (!title) throw new LautherError("approve() needs a title — it is the question.");
    return this.#request("/v1/approve", {
      title,
      wait: Math.min(Math.max(Number(wait) || 0, 0), MAX_WAIT_SECONDS),
      ...rest,
    });
  }

  /**
   * Ask about an approval you already started, by its notification id.
   *
   * Note this endpoint takes the token in the body rather than as a bearer
   * header — that is the API's shape, not a mistake here.
   *
   * For a request, the answer also carries `result` (what was shared, or
   * `null`) and `expired` (true once the request has lapsed unanswered).
   *
   * @param {string} id The `id` returned by `approve()` or `request()`.
   * @returns {Promise<import("./index.d.ts").PollResult>}
   */
  async poll(id) {
    if (!id) throw new LautherError("poll() needs the id returned by approve().");
    return this.#request("/v1/action/poll", {token: this.token, id});
  }

  /**
   * Ask a question and wait for the answer, for as long as you are willing.
   *
   * The server caps its own long-poll at 25 seconds, which suits a shell
   * one-liner and not an agent whose owner has wandered off. Past that, this
   * keeps asking about the SAME notification rather than sending another one,
   * so the person sees one question on their phone and not a pile of them.
   *
   * @param {string} question
   * @param {import("./index.d.ts").WaitOptions} [options]
   * @returns {Promise<import("./index.d.ts").ApprovalOutcome>}
   */
  async requestApproval(question, options = {}) {
    const {
      timeoutSeconds = MAX_WAIT_SECONDS,
      pollIntervalMs = 3000,
      ...rest
    } = options;
    const startedAt = Date.now();
    const elapsed = () => (Date.now() - startedAt) / 1000;

    const started = await this.approve({
      title: question,
      wait: Math.min(timeoutSeconds, MAX_WAIT_SECONDS),
      ...rest,
    });
    if (started.response) {
      return {
        id: started.id, response: started.response,
        confirmedBy: started.confirmedBy ?? null, waitedSeconds: Math.round(elapsed()),
      };
    }

    while (elapsed() < timeoutSeconds) {
      await new Promise((r) => setTimeout(r, pollIntervalMs));
      const {response, confirmedBy} = await this.poll(started.id);
      if (response) {
        return {
          id: started.id, response,
          confirmedBy: confirmedBy ?? null, waitedSeconds: Math.round(elapsed()),
        };
      }
    }
    // Nobody answered. Deliberately NOT an error: "no answer" is a real
    // outcome a caller must handle, and throwing would tempt a catch that
    // treats it as a yes.
    return {
      id: started.id, response: null, confirmedBy: null,
      waitedSeconds: Math.round(elapsed()),
    };
  }

  /**
   * Ask the person to share something from their phone: where they are, or a
   * picture. The "yes" carries the payload.
   *
   * Like `approve()` this blocks server-side for up to 25 seconds, and
   * `response` is `"approve"`, `"deny"` or `null`. On an approve, `result`
   * holds what was shared (see `LocationResult` and `PhotoResult`); on
   * anything else it is `null`.
   *
   * @param {"location" | "photo"} kind
   * @param {import("./index.d.ts").RequestOptions} [options]
   * @returns {Promise<import("./index.d.ts").RequestResult>}
   */
  async request(kind, options) {
    if (!kind) {
      throw new LautherError('request() needs a kind: "location" or "photo".');
    }
    const {wait = MAX_WAIT_SECONDS, ...rest} = options ?? {};
    return this.#request("/v1/request", {
      kind,
      ...rest,
      wait: Math.min(Math.max(Number(wait) || 0, 0), MAX_WAIT_SECONDS),
    });
  }

  /**
   * Ask for the person's position, once, and wait for the answer as long as
   * you are willing. Same waiting rules as `requestApproval()`: one request
   * on the phone, polled past the server's 25s cap, never thrown on timeout.
   *
   * @param {import("./index.d.ts").RequestWaitOptions} [options]
   * @returns {Promise<import("./index.d.ts").RequestOutcome<import("./index.d.ts").LocationResult>>}
   */
  requestLocation(options = {}) {
    return this.#requestAndWait("location", options);
  }

  /**
   * Ask for one picture and wait for it. Same waiting rules as
   * `requestApproval()`. `result.url` is a download link that expires after
   * 7 days.
   *
   * @param {import("./index.d.ts").RequestWaitOptions} [options]
   * @returns {Promise<import("./index.d.ts").RequestOutcome<import("./index.d.ts").PhotoResult>>}
   */
  requestPhoto(options = {}) {
    return this.#requestAndWait("photo", options);
  }

  /**
   * Shared by `requestLocation()` and `requestPhoto()`: start the request,
   * then keep asking about the SAME notification until it is answered,
   * expires, or `timeoutSeconds` runs out.
   *
   * @param {"location" | "photo"} kind
   * @param {import("./index.d.ts").RequestWaitOptions} options
   */
  async #requestAndWait(kind, options) {
    const {
      timeoutSeconds = MAX_WAIT_SECONDS,
      pollIntervalMs = 3000,
      ...rest
    } = options ?? {};
    const startedAt = Date.now();
    const elapsed = () => (Date.now() - startedAt) / 1000;

    const started = await this.request(kind, {
      ...rest,
      wait: Math.min(timeoutSeconds, MAX_WAIT_SECONDS),
    });
    if (started.response) {
      return {
        id: started.id, response: started.response,
        confirmedBy: started.confirmedBy ?? null, result: started.result ?? null,
        waitedSeconds: Math.round(elapsed()), expired: false,
      };
    }

    while (elapsed() < timeoutSeconds) {
      await new Promise((r) => setTimeout(r, pollIntervalMs));
      const {response, confirmedBy, result, expired} = await this.poll(started.id);
      if (response) {
        return {
          id: started.id, response, confirmedBy: confirmedBy ?? null,
          result: result ?? null, waitedSeconds: Math.round(elapsed()),
          expired: false,
        };
      }
      // The request lapsed on the phone: nothing more can arrive, so stop
      // waiting rather than idling out the rest of the timeout.
      if (expired === true) {
        return {
          id: started.id, response: null, confirmedBy: null, result: null,
          waitedSeconds: Math.round(elapsed()), expired: true,
        };
      }
    }
    // Nobody answered. As with requestApproval(): an outcome, not an error.
    return {
      id: started.id, response: null, confirmedBy: null, result: null,
      waitedSeconds: Math.round(elapsed()), expired: false,
    };
  }

  /**
   * `requestApproval()` reduced to a boolean, for the common `if` around
   * something irreversible.
   *
   * **Only an explicit Approve returns true.** A denial and a timeout both
   * return false, which is the safe way round: an unanswered question must
   * never read as a yes.
   *
   * @param {string} question
   * @param {import("./index.d.ts").WaitOptions} [options]
   * @returns {Promise<boolean>}
   */
  async ask(question, options = {}) {
    const out = await this.requestApproval(question, options);
    return out.response === "approve";
  }

  /**
   * @param {string} path
   * @param {Record<string, unknown>} body
   */
  async #request(path, body) {
    let res;
    try {
      res = await this._fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(compact(body)),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      // A timeout here is the network, not a denial. Say so, because the
      // caller's next decision depends on telling those apart.
      throw new LautherError(
        `Could not reach Lauther at ${this.baseUrl}${path}: ${cause?.message ?? cause}`,
        {body: undefined});
    }

    const text = await res.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = {raw: text};
    }

    if (!res.ok) {
      const code = isObject(parsed) && typeof parsed.code === "string" ?
        parsed.code : undefined;
      const message = isObject(parsed) && typeof parsed.error === "string" ?
        parsed.error : `HTTP ${res.status}`;
      throw new LautherError(message, {status: res.status, code, body: parsed});
    }
    return parsed;
  }
}

/**
 * Convenience for the one-liner case, reading the token from
 * `process.env.LAUTHER_TOKEN`.
 *
 * @param {import("./index.d.ts").PushOptions} options
 */
export function push(options) {
  return new Lauther(process.env?.LAUTHER_TOKEN).push(options);
}

/**
 * As `push`, for a question. Returns true only on an explicit Approve.
 *
 * @param {string} question
 * @param {Omit<import("./index.d.ts").ApproveOptions, "title">} [options]
 */
export function ask(question, options) {
  return new Lauther(process.env?.LAUTHER_TOKEN).ask(question, options);
}

export default Lauther;
