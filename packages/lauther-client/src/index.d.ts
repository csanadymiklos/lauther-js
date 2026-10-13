/**
 * Priority. 2 is the only level that crosses quiet hours — the setting you
 * want on about three things and no more.
 */
export type Priority = -2 | -1 | 0 | 1 | 2;

export interface PushOptions {
  /** Shown as the notification's headline. Trimmed to 250 characters. */
  title?: string;
  /** The body. Trimmed to 2000 characters. */
  message?: string;
  priority?: Priority;
  /** A link the notification opens. Use `path` instead for a paired site. */
  url?: string;
  /** Path on your paired site. Opens signed in; must be same-origin. */
  path?: string;
  /** Groups related notifications so a new one replaces the last. */
  tag?: string;
  icon?: string;
  color?: string;
  sound?: string;
  /** Image URL. Supporter accounts only; otherwise dropped, never fatal. */
  image?: string;
  /** Base64 image. Same entitlement as `image`. */
  imageBase64?: string;
}

export interface PushResult {
  ok: true;
  id: string;
  /** Devices that took the message. 0 with `devices: 0` means none registered. */
  delivered: number;
  /** Devices Lauther tried. */
  devices: number;
  /** `"stored"`, or `"omitted_not_entitled"` when the account cannot attach images. */
  image?: "stored" | "omitted_not_entitled";
  /** Present only when every device rejected it. */
  reason?: "devices_rejected";
  errors?: Record<string, unknown>;
}

export interface ApproveOptions {
  /** The question. Required — it is what you are being asked to approve. */
  title: string;
  message?: string;
  /** Seconds to wait for an answer, 0-25. Defaults to 25. */
  wait?: number;
  /** Label on the approve button. Defaults to "Approve". */
  approveTitle?: string;
  /** Label on the deny button. Defaults to "Deny". */
  denyTitle?: string;
  /**
   * Demand a fingerprint or face before Approve is accepted. Denying never
   * requires one — refusing should always be cheap.
   */
  requireBiometric?: boolean;
  priority?: Priority;
}

export interface ApproveResult {
  ok: true;
  id: string;
  /** `null` means nobody answered in time. Silence is not consent. */
  response: "approve" | "deny" | null;
}

export interface PollResult {
  /** `null` until someone answers. */
  response: "approve" | "deny" | null;
  /** How the answer was confirmed, e.g. a biometric check. `null` if not. */
  confirmedBy: string | null;
  /**
   * What a request carried back: a `LocationResult` or `PhotoResult` once
   * approved, `null` until then, when denied, and for plain approvals.
   */
  result?: LocationResult | PhotoResult | null;
  /** `true` once a request has lapsed unanswered; there is no point polling on. */
  expired?: boolean;
}

export interface WaitOptions extends Omit<ApproveOptions, "title" | "wait"> {
  /**
   * How long to wait in total, in seconds. The server long-polls for the
   * first 25s; beyond that the client polls the same notification, so the
   * person still sees exactly one question.
   */
  timeoutSeconds?: number;
  /** Gap between polls once past the server's 25s window. Defaults to 3000. */
  pollIntervalMs?: number;
}

export interface ApprovalOutcome {
  id: string;
  /** `null` means nobody answered in time. Silence is not consent. */
  response: "approve" | "deny" | null;
  confirmedBy: string | null;
  waitedSeconds: number;
}

/** The kinds of thing a person can be asked to share. */
export type RequestKind = "location" | "photo";

export interface RequestOptions {
  /** The question. Defaults to "Share your location?" / "Take a photo?". */
  title?: string;
  message?: string;
  /** Demand a fingerprint or face before the share goes out. */
  requireBiometric?: boolean;
  priority?: Priority;
  /** Seconds to wait for an answer, 0-25. Defaults to 25. */
  wait?: number;
  /** Seconds the request stays answerable, 60-3600. Defaults to 600. */
  expiresIn?: number;
}

/** One position, as the phone read it a moment before sending. */
export interface LocationResult {
  lat: number;
  lng: number;
  /** Metres. Absent when the phone did not report one. */
  accuracy?: number;
  /** ISO 8601 time of the reading. */
  at: string;
}

/** One picture. Shared photos are kept for 7 days, then deleted. */
export interface PhotoResult {
  /** Download link for the JPEG. */
  url: string;
  bytes: number;
  width?: number;
  height?: number;
}

export interface RequestResult {
  ok: true;
  id: string;
  /** `null` means nobody answered in time. Silence is not consent. */
  response: "approve" | "deny" | null;
  /** What was shared. `null` unless the person approved. */
  result: LocationResult | PhotoResult | null;
}

export interface RequestWaitOptions extends Omit<RequestOptions, "wait"> {
  /**
   * How long to wait in total, in seconds. The server long-polls for the
   * first 25s; beyond that the client polls the same request, so the person
   * still sees exactly one.
   */
  timeoutSeconds?: number;
  /** Gap between polls once past the server's 25s window. Defaults to 3000. */
  pollIntervalMs?: number;
}

export interface RequestOutcome<R = LocationResult | PhotoResult> {
  id: string;
  /** `null` means nobody answered, or the request expired. */
  response: "approve" | "deny" | null;
  confirmedBy: string | null;
  /** What was shared. `null` unless `response` is `"approve"`. */
  result: R | null;
  waitedSeconds: number;
  /** `true` when the request lapsed on the phone before anyone answered. */
  expired: boolean;
}

export interface LautherOptions {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  /** Client-side abort. Defaults to 40s, comfortably past the 25s server wait. */
  timeoutMs?: number;
}

export declare class LautherError extends Error {
  name: "LautherError";
  /** HTTP status, absent when the request never reached the server. */
  status?: number;
  /** Machine-readable reason. Branch on this, never on `message`. */
  code?: string;
  body?: unknown;
}

export declare class Lauther {
  constructor(token: string, options?: LautherOptions);
  token: string;
  baseUrl: string;
  timeoutMs: number;
  push(options: PushOptions): Promise<PushResult>;
  approve(options: ApproveOptions): Promise<ApproveResult>;
  /** Ask about an approval already started, by its notification id. */
  poll(id: string): Promise<PollResult>;
  /** Ask and wait, past the server's 25s cap, on one notification. */
  requestApproval(question: string, options?: WaitOptions): Promise<ApprovalOutcome>;
  /** Ask the person to share `"location"` or a `"photo"`; answers within `wait` seconds. */
  request(kind: RequestKind, options?: RequestOptions): Promise<RequestResult>;
  /** Ask for the person's position and wait, past the server's 25s cap. */
  requestLocation(options?: RequestWaitOptions): Promise<RequestOutcome<LocationResult>>;
  /** Ask for one picture and wait, past the server's 25s cap. */
  requestPhoto(options?: RequestWaitOptions): Promise<RequestOutcome<PhotoResult>>;
  /** True only on an explicit Approve; a denial and a timeout are both false. */
  ask(question: string, options?: WaitOptions): Promise<boolean>;
}

export declare function push(options: PushOptions): Promise<PushResult>;
export declare function ask(question: string, options?: WaitOptions): Promise<boolean>;

export default Lauther;
