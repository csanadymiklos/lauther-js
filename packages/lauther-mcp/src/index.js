#!/usr/bin/env node
/**
 * lauther-mcp — an MCP server that puts a human in the loop, on their phone.
 *
 * Two tools, and resisting a third is the point:
 *
 *   ask_approval      the agent is about to do something irreversible and
 *                     asks first. Blocks until a person answers.
 *   send_notification  "the migration finished", "the build broke".
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

export function buildServer() {
  const server = new McpServer({ name: "lauther", version: "0.1.0" });

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
