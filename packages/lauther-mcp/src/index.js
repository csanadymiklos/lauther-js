#!/usr/bin/env node
/**
 * lauther-mcp — an MCP server that puts a human in the loop, on their phone.
 *
 * Five tools, each one thing an agent needs a person for:
 *
 *   ask_approval       the agent is about to do something irreversible and
 *                      asks first. Blocks until a person answers.
 *   send_notification  "the migration finished", "the build broke".
 *   get_location       "where are you?" - one position, shared on a tap.
 *   request_photo      "show me" - one picture, taken or picked on the phone.
 *   ask_text           "what is the code?" - a short answer, typed on the phone.
 *
 * The interesting one is ask_approval. Lauther's /v1/approve long-polls for at
 * most 25 seconds, which suits a shell one-liner and not an agent whose owner
 * has wandered off — so the client keeps asking about the SAME notification
 * past that, and the person sees one question rather than a pile of them.
 *
 * @see https://lauther.app/docs.html
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Lauther, LautherError } from "lauther-client";
import { createRequire } from "node:module";

const PKG_VERSION = createRequire(import.meta.url)("../package.json").version;

const TOKEN = process.env.LAUTHER_TOKEN;
const BASE_URL = process.env.LAUTHER_BASE_URL; // tests and self-hosted relays

if (!TOKEN) {
  // stderr, never stdout: stdout is the MCP transport and anything else on it
  // corrupts the stream before the client can report a useful error.
  process.stderr.write(
    "lauther-mcp: LAUTHER_TOKEN is not set.\n" +
    "Get a token in the Lauther app under Apps -> + -> New token, then put it\n" +
    "in the env block of your MCP config. https://lauther.app/docs.html\n");
  process.exit(1);
}

const lauther = new Lauther(TOKEN, BASE_URL ? { baseUrl: BASE_URL } : {});

/** The server keeps shared photos for 7 days (SPEC_REQUESTS 1.5). */
const PHOTO_RETENTION = "7 days";

/** A shared photo is shown to the agent inline; the API caps uploads at 2 MB. */
const MAX_INLINE_PHOTO_BYTES = 4 * 1024 * 1024;

const text = (s) => ({ content: [{ type: "text", text: s }] });
const failure = (s) => ({ content: [{ type: "text", text: s }], isError: true });

/** Turn any thrown thing into one line an agent can act on. */
function explain(err) {
  if (err instanceof LautherError) {
    if (err.status === 401 || err.status === 403) {
      return `Lauther rejected the token (HTTP ${err.status}): ${err.message}. ` +
        "Check LAUTHER_TOKEN, and that it has not been revoked in the app.";
    }
    return `Lauther error${err.status ? ` (HTTP ${err.status})` : ""}: ${err.message}`;
  }
  return `Unexpected error: ${err?.message ?? String(err)}`;
}

/** `2026-10-13T09:00:00.000Z` becomes `2026-10-13T09:00:00Z`; anything odd passes through. */
function isoSeconds(at) {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? String(at) : d.toISOString().replace(/\.\d+Z$/, "Z");
}

/** " Confirmed by biometric." or nothing. */
const confirmation = (out) => (out.confirmedBy ? ` Confirmed by ${out.confirmedBy}.` : "");

/**
 * The non-yes outcomes of a request, worded for an agent. Returns null when
 * the person did approve, so the caller can describe what was shared.
 *
 * @param {string} what "location", "photo" or "answer", for the sentence
 */
function notShared(out, what) {
  if (out.response === "approve") return null;
  if (out.response === "deny") {
    return text(`DECLINED after ${out.waitedSeconds}s. Do not retry, and do not try ` +
      `to get the ${what} another way - report the refusal and stop.`);
  }
  if (out.expired) {
    return text(`EXPIRED after ${out.waitedSeconds}s - the request lapsed on their ` +
      `phone before anyone answered, and no ${what} was shared. Expiry is not ` +
      "consent: say it expired and let the human restart it when they are back.");
  }
  return text(`NO ANSWER after ${out.waitedSeconds}s - nobody responded, so no ` +
    `${what} was shared. Silence is not consent: say the request went unanswered ` +
    "and let the human restart it when they are back.");
}

/** Fetch a shared photo for inline display. Null on any failure: the text still works. */
async function fetchPhoto(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_INLINE_PHOTO_BYTES) return null;
    return bytes.toString("base64");
  } catch {
    return null;
  }
}

export function buildServer() {
  // The version comes from package.json so it cannot drift from what npm
  // published (it did once: 0.1.1 on npm reported itself as 0.1.0).
  const server = new McpServer({ name: "lauther", version: PKG_VERSION });

  server.registerTool(
    "ask_approval",
    {
      title: "Ask a human for approval",
      description:
        "Ask the human who owns this machine to approve or deny something, on " +
        "their phone, and wait for the answer. Use this BEFORE anything " +
        "irreversible or expensive: deploying, deleting data, spending money, " +
        "sending mail to real people, force-pushing, touching production. " +
        "Returns APPROVED, DENIED, or NO ANSWER. Proceed only on APPROVED — " +
        "a denial and a timeout both mean stop.",
      inputSchema: {
        question: z.string().min(1).max(250)
          .describe("The question, as the person will read it on a lock screen. " +
            "Be specific: 'Drop and recreate the users table on staging?' beats " +
            "'Proceed?'."),
        details: z.string().max(2000).optional()
          .describe("Context that helps them decide — what changes, how much it " +
            "costs, what breaks if it goes wrong."),
        require_biometric: z.boolean().optional()
          .describe("Demand a fingerprint or face before the approval counts. " +
            "Denying never requires one; refusing should always be cheap."),
        timeout_seconds: z.number().int().min(5).max(900).optional()
          .describe("How long to wait for an answer. Defaults to 120."),
      },
    },
    async ({ question, details, require_biometric, timeout_seconds = 120 }) => {
      try {
        const out = await lauther.requestApproval(question, {
          message: details,
          requireBiometric: require_biometric,
          timeoutSeconds: timeout_seconds,
        });
        if (out.response === "approve") {
          const how = out.confirmedBy
            ? ` Confirmed by ${out.confirmedBy}.`
            : "";
          return text(`APPROVED after ${out.waitedSeconds}s.${how} You may proceed ` +
            "with exactly what you asked about, and nothing further.");
        }
        if (out.response === "deny") {
          return text(`DENIED after ${out.waitedSeconds}s. Do not proceed. Do not ` +
            "retry the same question, and do not look for another way to do it — " +
            "report the refusal and stop.");
        }
        return text(`NO ANSWER after ${out.waitedSeconds}s — nobody responded. Do ` +
          "not proceed: silence is not consent. Say the request went unanswered " +
          "and let the human restart it when they are back.");
      } catch (err) {
        return failure(explain(err) + " No approval was obtained, so do not proceed.");
      }
    },
  );

  server.registerTool(
    "send_notification",
    {
      title: "Send a notification to the human's phone",
      description:
        "Tell the human something, on their phone. Use for finishing a long " +
        "job, a build breaking, or anything worth interrupting them for. This " +
        "does NOT wait for a reply — use ask_approval when you need permission.",
      inputSchema: {
        title: z.string().min(1).max(250).describe("The headline."),
        message: z.string().max(2000).optional().describe("The body."),
        priority: z.enum(["lowest", "low", "normal", "high", "urgent"]).optional()
          .describe("Defaults to normal. 'urgent' is the only level that crosses " +
            "quiet hours — worth using on about three things and no more."),
        url: z.string().url().optional().describe("A link the notification opens."),
      },
    },
    async ({ title, message, priority = "normal", url }) => {
      const LEVELS = { lowest: -2, low: -1, normal: 0, high: 1, urgent: 2 };
      try {
        const out = await lauther.push({
          title, message, url, priority: LEVELS[priority],
        });
        if (out.devices === 0) {
          return text("Lauther accepted the notification but NO DEVICE is " +
            "registered on this account, so no phone buzzed. Usually the app has " +
            "not been opened since signing in.");
        }
        if (out.delivered === 0) {
          return text(`Lauther accepted it but all ${out.devices} device(s) ` +
            "rejected it. The push token is probably stale — reopening the app " +
            "usually fixes it.");
        }
        return text(`Sent — delivered to ${out.delivered} of ${out.devices} device(s).`);
      } catch (err) {
        return failure(explain(err));
      }
    },
  );

  server.registerTool(
    "get_location",
    {
      title: "Ask a human to share their location",
      description:
        "Ask the human who owns this phone to share where they are right now. " +
        "They get a prompt and choose Share or Decline; if they share, one " +
        "position is sent, once, as it was at that moment. Use it when you " +
        "need their location to do the task (find the nearest branch, set a " +
        "timezone, log a site visit), not to track them. Returns SHARED with " +
        "latitude, longitude and accuracy, or DECLINED, NO ANSWER or EXPIRED. " +
        "On anything but SHARED you have no location: do not guess one.",
      inputSchema: {
        question: z.string().min(1).max(250).optional()
          .describe("What they see on the prompt. Say why you need it: " +
            "'Share your location so I can find the nearest pharmacy?'. " +
            "Defaults to 'Share your location?'."),
        details: z.string().max(2000).optional()
          .describe("Anything else that helps them decide."),
        require_biometric: z.boolean().optional()
          .describe("Demand a fingerprint or face before the location is sent."),
        timeout_seconds: z.number().int().min(5).max(900).optional()
          .describe("How long to wait for an answer. Defaults to 120."),
      },
    },
    async ({ question = "Share your location?", details, require_biometric,
      timeout_seconds = 120 }) => {
      try {
        const out = await lauther.requestLocation({
          title: question,
          message: details,
          requireBiometric: require_biometric,
          timeoutSeconds: timeout_seconds,
        });
        const notYes = notShared(out, "location");
        if (notYes) return notYes;

        const loc = out.result;
        if (!loc || typeof loc.lat !== "number" || typeof loc.lng !== "number") {
          return failure("They approved, but Lauther returned no usable position. " +
            "You have no location: do not guess one.");
        }
        const accuracy = typeof loc.accuracy === "number"
          ? ` (±${Math.round(loc.accuracy)} m)` : "";
        const at = loc.at ? ` at ${isoSeconds(loc.at)}` : "";
        return text(`SHARED after ${out.waitedSeconds}s: ` +
          `${loc.lat.toFixed(4)}, ${loc.lng.toFixed(4)}${accuracy}${at}.` +
          `${confirmation(out)} That is where they were at that moment, shared once ` +
          "for what you asked about - use it for that and nothing else.");
      } catch (err) {
        return failure(explain(err) + " No location was obtained, so do not guess one.");
      }
    },
  );

  server.registerTool(
    "request_photo",
    {
      title: "Ask a human for a photo",
      description:
        "Ask the human who owns this phone for one picture. They get a prompt " +
        "and choose to take a photo (or pick one) or Decline. Use it when you " +
        "need to see something only they can show you: a label, a screen, a " +
        "whiteboard, a damaged part. Returns SHARED with a link plus the image " +
        "itself so you can look at it directly, or DECLINED, NO ANSWER or " +
        "EXPIRED. The link works for 7 days and the photo is then deleted.",
      inputSchema: {
        question: z.string().min(1).max(250).optional()
          .describe("What they see on the prompt. Say what you need to see: " +
            "'Take a photo of the error on the printer display?'. " +
            "Defaults to 'Take a photo?'."),
        details: z.string().max(2000).optional()
          .describe("Anything else that helps them decide or frame the shot."),
        require_biometric: z.boolean().optional()
          .describe("Demand a fingerprint or face before the photo is sent."),
        timeout_seconds: z.number().int().min(5).max(900).optional()
          .describe("How long to wait for an answer. Defaults to 120."),
      },
    },
    async ({ question = "Take a photo?", details, require_biometric,
      timeout_seconds = 120 }) => {
      try {
        const out = await lauther.requestPhoto({
          title: question,
          message: details,
          requireBiometric: require_biometric,
          timeoutSeconds: timeout_seconds,
        });
        const notYes = notShared(out, "photo");
        if (notYes) return notYes;

        const photo = out.result;
        if (!photo || typeof photo.url !== "string") {
          return failure("They approved, but Lauther returned no photo. You have " +
            "nothing to look at: do not guess what it showed.");
        }
        const size = photo.width && photo.height ? ` ${photo.width}x${photo.height}` : "";
        const line = `SHARED after ${out.waitedSeconds}s: photo${size} at ${photo.url} ` +
          `- available for ${PHOTO_RETENTION}.${confirmation(out)}`;

        const data = await fetchPhoto(photo.url);
        if (!data) {
          return text(`${line} The image could not be fetched to show you inline, ` +
            "but the link above still works.");
        }
        return {
          content: [
            { type: "text", text: `${line} The picture is attached.` },
            { type: "image", data, mimeType: "image/jpeg" },
          ],
        };
      } catch (err) {
        return failure(explain(err) + " No photo was obtained, so do not guess what it showed.");
      }
    },
  );

  server.registerTool(
    "ask_text",
    {
      title: "Ask a human a short question",
      description:
        "Ask the human who owns this phone a short question and wait for them " +
        "to type the answer on it. Use it for something only they know: a " +
        "verification code, a choice between options, a name, a short fact. " +
        "Never for long text (answers are capped at 500 characters), and not " +
        "for permission to act: use ask_approval for that. Returns ANSWERED " +
        "with exactly what they typed, or DECLINED, NO ANSWER or EXPIRED. On " +
        "anything but ANSWERED you have no answer: do not guess one.",
      inputSchema: {
        question: z.string().min(1).max(250).optional()
          .describe("The question, as they read it on a lock screen. Be " +
            "specific about the shape of the answer: 'What is the 6-digit " +
            "code from your authenticator?'. Defaults to 'Answer a question?'."),
        details: z.string().max(2000).optional()
          .describe("Anything else that helps them answer."),
        placeholder: z.string().max(80).optional()
          .describe("A hint shown in the answer field, e.g. '6-digit code'."),
        require_biometric: z.boolean().optional()
          .describe("Demand a fingerprint or face before the answer is sent."),
        timeout_seconds: z.number().int().min(5).max(900).optional()
          .describe("How long to wait for an answer. Defaults to 120."),
      },
    },
    async ({ question = "Answer a question?", details, placeholder, require_biometric,
      timeout_seconds = 120 }) => {
      try {
        const out = await lauther.requestText({
          title: question,
          message: details,
          placeholder,
          requireBiometric: require_biometric,
          timeoutSeconds: timeout_seconds,
        });
        const notYes = notShared(out, "answer");
        if (notYes) return notYes;

        const answer = out.result;
        if (!answer || typeof answer.text !== "string") {
          return failure("They replied, but Lauther returned no usable answer. " +
            "You have no answer: do not guess one.");
        }
        return text(`ANSWERED after ${out.waitedSeconds}s: ${JSON.stringify(answer.text)}.` +
          `${confirmation(out)} That is what they typed, sent once in reply to what ` +
          "you asked - use it for that and nothing else.");
      } catch (err) {
        return failure(explain(err) + " No answer was obtained, so do not guess one.");
      }
    },
  );

  return server;
}

// Only start a transport when run as a program, so tests can import
// buildServer() without hijacking stdio.
const isMain = process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href;

if (isMain || process.env.LAUTHER_MCP_FORCE_START === "1") {
  const server = buildServer();
  await server.connect(new StdioServerTransport());
}
