/**
 * Thin typed client for the WhatsApp Cloud API. Consumed from
 * `apps/integrations` (server-side) when an operator sends an outbound
 * message, or by Cloud Functions reacting to webhook events.
 *
 * The Flutter app currently writes Mensagem documents to Firestore and
 * a Python Cloud Function pushes them to WhatsApp. This client exists
 * for the Next-side equivalent path (e.g. the inbox replying directly
 * via the API) and remains optional during the migration.
 *
 * Media URL resolution (`getMediaData`) and download (`downloadMedia`)
 * land with #527 for the inbound pipeline (caching received media);
 * outbound media send (`sendMedia`, image/video/audio/document by LINK)
 * lands with #529 for the operator-reply pipeline.
 */

import {
  mediaMetadataSchema,
  phoneNumberStatusSchema,
  subscribedAppsResponseSchema,
  type MediaMetadata,
  type PhoneNumberStatus,
  type SubscribedApp,
} from './types';

export const GRAPH_BASE = 'https://graph.facebook.com';
/** Default Graph API version, overridable via `WhatsAppClientConfig.graphApiVersion`. */
export const DEFAULT_GRAPH_API_VERSION = 'v23.0';

/** Cap the Graph error payload carried on a {@link WhatsAppHttpError} (snippet only). */
const ERROR_BODY_MAX = 500;

function snippet(body: string): string {
  return body.length > ERROR_BODY_MAX ? `${body.slice(0, ERROR_BODY_MAX)}…` : body;
}

/**
 * A non-2xx (or unusable-2xx) Graph API response. Carries the HTTP `status` and a
 * `body` snippet of the Graph error payload for diagnosis — the RESPONSE body
 * only, never the request (which holds the bearer token). Terminal from the
 * caller's perspective (bad request / auth / permanent Graph error): the #529
 * outbound disposition maps it to `estadoEnvio = erro`.
 */
export class WhatsAppHttpError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(operation: string, status: number, body: string) {
    const trimmed = snippet(body);
    super(`WhatsApp ${operation} failed (${status}): ${trimmed}`);
    this.name = 'WhatsAppHttpError';
    this.status = status;
    this.body = trimmed;
  }
}

/**
 * A transport-level failure reaching the Graph API — the `fetch` itself rejected
 * (DNS / connection reset / timeout), so no HTTP response was received. Transient:
 * the #529 outbound disposition RETHROWS so Eventarc retries.
 */
export class WhatsAppNetworkError extends Error {
  readonly operation: string;
  constructor(operation: string, cause: unknown) {
    super(
      `WhatsApp ${operation} network error: ${cause instanceof Error ? cause.message : String(cause)}`,
      {
        cause,
      },
    );
    this.name = 'WhatsAppNetworkError';
    this.operation = operation;
  }
}

export interface WhatsAppClientConfig {
  /**
   * Phone number ID assigned to the WhatsApp Business Account. Found
   * in Meta Business Manager → WhatsApp → API Setup.
   */
  phoneNumberId: string;
  /**
   * Long-lived access token (or short-lived during dev). Treat as a
   * secret; never expose to client bundles.
   */
  accessToken: string;
  /**
   * Override fetch (mostly for tests). Defaults to global fetch.
   */
  fetch?: typeof fetch;
  /**
   * API version (e.g. "v21.0"). Defaults to the latest stable at
   * package release time.
   */
  graphApiVersion?: string;
}

export interface SendTextInput {
  to: string;
  text: string;
  /**
   * If set, marks `text` as a reply to the given inbound message ID.
   */
  replyTo?: string;
}

/** Outbound media message sent by LINK (a publicly-fetchable URL). */
export interface SendMediaInput {
  to: string;
  /**
   * WhatsApp media kind. The Graph API nests the media object under a key
   * equal to this value (`image`/`video`/`audio`/`document`).
   */
  type: 'image' | 'video' | 'audio' | 'document';
  /**
   * Publicly fetchable media URL — the cached `Arquivo` download URL. Meta
   * downloads it server-side, so it must be reachable without the account's
   * bearer token (unlike the inbound lookaside URLs in {@link downloadMedia}).
   */
  link: string;
  /**
   * Caption shown under the media. Honored by WhatsApp for image/video/
   * document only (ignored for audio) — callers omit it for audio.
   */
  caption?: string;
  /** If set, marks this as a reply to the given inbound message ID. */
  replyTo?: string;
}

export interface SendResult {
  messageId: string;
}

/** {@link WhatsAppClient.requestVerificationCode} input. */
export interface RequestVerificationCodeInput {
  /** How Meta delivers the 6-digit code to the number. */
  codeMethod: 'SMS' | 'VOICE';
  /** BCP-47-ish language for the delivered message. Defaults to `pt_BR`. */
  language?: string;
}

/** {@link WhatsAppClient.verifyCode} input. */
export interface VerifyCodeInput {
  /** The 6-digit code the operator received via SMS/VOICE. */
  code: string;
}

/** {@link WhatsAppClient.register} input. */
export interface RegisterInput {
  /** The 6-digit two-step registration PIN. NEVER surfaced in error text. */
  pin: string;
}

/** Result of {@link WhatsAppClient.downloadMedia}. */
export interface MediaDownload {
  /** Raw bytes of the downloaded media. */
  data: Uint8Array;
  /** `content-type` response header, if the API sent one. */
  contentType: string | null;
}

export class WhatsAppClient {
  constructor(private readonly cfg: WhatsAppClientConfig) {}

  private get fetcher(): typeof fetch {
    return this.cfg.fetch ?? fetch;
  }

  private get version(): string {
    return this.cfg.graphApiVersion ?? DEFAULT_GRAPH_API_VERSION;
  }

  /**
   * Perform the Graph call, converting a transport-level rejection (the `fetch`
   * never produced a response) into a {@link WhatsAppNetworkError}. A non-2xx
   * response is still a resolved `Response` — callers turn that into a
   * {@link WhatsAppHttpError}.
   */
  private async doFetch(operation: string, input: string, init?: RequestInit): Promise<Response> {
    try {
      return await this.fetcher(input, init);
    } catch (err) {
      throw new WhatsAppNetworkError(operation, err);
    }
  }

  async sendText(input: SendTextInput): Promise<SendResult> {
    const body: Record<string, unknown> = {
      messaging_product: 'whatsapp',
      to: input.to,
      type: 'text',
      text: { body: input.text, preview_url: false },
    };
    if (input.replyTo) {
      body.context = { message_id: input.replyTo };
    }
    const res = await this.doFetch(
      'sendText',
      `${GRAPH_BASE}/${this.version}/${this.cfg.phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.cfg.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) {
      const text = await res.text();
      throw new WhatsAppHttpError('sendText', res.status, text);
    }
    const json = (await res.json()) as { messages?: Array<{ id: string }> };
    const id = json.messages?.[0]?.id;
    if (!id) {
      throw new WhatsAppHttpError('sendText', res.status, 'response missing messages[0].id');
    }
    return { messageId: id };
  }

  /**
   * Send an outbound media message by LINK — the Cloud API downloads the URL
   * server-side (the cached `Arquivo` download URL). Mirrors {@link sendText}'s
   * shape and error handling: nests the media object (`{ link, caption? }`)
   * under a key equal to `input.type`. Ported from legacy
   * `WhatsAppMessage.createMessageBySenderId` + `MediaContent`
   * (`.old/.../api_v23/message.dart`), which posts `{ link, caption }` too.
   */
  async sendMedia(input: SendMediaInput): Promise<SendResult> {
    const media: Record<string, unknown> = { link: input.link };
    if (input.caption) media.caption = input.caption;
    const body: Record<string, unknown> = {
      messaging_product: 'whatsapp',
      to: input.to,
      type: input.type,
      [input.type]: media,
    };
    if (input.replyTo) {
      body.context = { message_id: input.replyTo };
    }
    const res = await this.doFetch(
      'sendMedia',
      `${GRAPH_BASE}/${this.version}/${this.cfg.phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.cfg.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) {
      const text = await res.text();
      throw new WhatsAppHttpError('sendMedia', res.status, text);
    }
    const json = (await res.json()) as { messages?: Array<{ id: string }> };
    const id = json.messages?.[0]?.id;
    if (!id) {
      throw new WhatsAppHttpError('sendMedia', res.status, 'response missing messages[0].id');
    }
    return { messageId: id };
  }

  /**
   * Resolve a media id (from an inbound message's `image`/`video`/`audio`/
   * `document`/`sticker` field) to a short-lived download URL plus
   * metadata. Mirrors legacy `getMediaData`
   * (`.old/.../whatsapp_cloud_api/lib/src/api_v23/api.dart:279`).
   *
   * The returned `url` is a "lookaside" URL: it is NOT publicly
   * fetchable and expires quickly — pass it to {@link downloadMedia}
   * (with the same access token) right away rather than persisting it.
   */
  async getMediaData(mediaId: string): Promise<MediaMetadata> {
    const res = await this.doFetch('getMediaData', `${GRAPH_BASE}/${this.version}/${mediaId}`, {
      headers: {
        authorization: `Bearer ${this.cfg.accessToken}`,
        'content-type': 'application/json',
      },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new WhatsAppHttpError('getMediaData', res.status, text);
    }
    const json = await res.json();
    return mediaMetadataSchema.parse(json);
  }

  /**
   * Download media bytes from the lookaside URL returned by
   * {@link getMediaData}. Mirrors legacy `downloadMedia`
   * (`.old/.../whatsapp_cloud_api/lib/src/api_v23/api.dart:288`): despite
   * being a Meta CDN URL, it requires the same `Authorization: Bearer`
   * header as the Graph API — it is not a public URL.
   */
  async downloadMedia(mediaUrl: string): Promise<MediaDownload> {
    const res = await this.doFetch('downloadMedia', mediaUrl, {
      headers: {
        authorization: `Bearer ${this.cfg.accessToken}`,
      },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new WhatsAppHttpError('downloadMedia', res.status, text);
    }
    const buffer = await res.arrayBuffer();
    return {
      data: new Uint8Array(buffer),
      contentType: res.headers.get('content-type'),
    };
  }

  /**
   * Mark an inbound message as read. WhatsApp shows the blue ticks once
   * this is acknowledged.
   */
  async markRead(messageId: string): Promise<void> {
    const res = await this.doFetch(
      'markRead',
      `${GRAPH_BASE}/${this.version}/${this.cfg.phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.cfg.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          status: 'read',
          message_id: messageId,
        }),
      },
    );
    if (!res.ok) {
      const text = await res.text();
      throw new WhatsAppHttpError('markRead', res.status, text);
    }
  }

  private authJsonHeaders(): Record<string, string> {
    return {
      authorization: `Bearer ${this.cfg.accessToken}`,
      'content-type': 'application/json',
    };
  }

  /**
   * Request a 6-digit verification code for the number (PIN/SMS registration,
   * step 1). `POST /{phoneNumberId}/request_code { code_method, language }`.
   * Ported from legacy `requestCodeForNumber`
   * (`.old/.../api_v23/api.dart:188`). Reference:
   * https://developers.facebook.com/docs/whatsapp/cloud-api/reference/phone-numbers#verify
   */
  async requestVerificationCode(input: RequestVerificationCodeInput): Promise<void> {
    const res = await this.doFetch(
      'requestVerificationCode',
      `${GRAPH_BASE}/${this.version}/${this.cfg.phoneNumberId}/request_code`,
      {
        method: 'POST',
        headers: this.authJsonHeaders(),
        body: JSON.stringify({
          code_method: input.codeMethod,
          language: input.language ?? 'pt_BR',
        }),
      },
    );
    if (!res.ok) {
      const text = await res.text();
      throw new WhatsAppHttpError('requestVerificationCode', res.status, text);
    }
  }

  /**
   * Verify the 6-digit code (step 2). `POST /{phoneNumberId}/verify_code
   * { code }`. Ported from legacy `verifyCodeForNumber`
   * (`.old/.../api_v23/api.dart:207`), which treats `success == true` as the
   * pass signal — a 2xx body lacking it is still a failure (throws).
   */
  async verifyCode(input: VerifyCodeInput): Promise<void> {
    const res = await this.doFetch(
      'verifyCode',
      `${GRAPH_BASE}/${this.version}/${this.cfg.phoneNumberId}/verify_code`,
      {
        method: 'POST',
        headers: this.authJsonHeaders(),
        body: JSON.stringify({ code: input.code }),
      },
    );
    const text = await res.text();
    if (!res.ok) {
      throw new WhatsAppHttpError('verifyCode', res.status, text);
    }
    if (!isSuccessBody(text)) {
      throw new WhatsAppHttpError('verifyCode', res.status, text);
    }
  }

  /**
   * Register the number with its two-step PIN. `POST /{phoneNumberId}/register
   * { messaging_product: 'whatsapp', pin }`. Ported from legacy `register` /
   * `registrarPin` (`.old/.../api_v23/api.dart:222`,
   * `.old/lib/whatsapp/providers/provider.dart:322`), which treats
   * `success == true` as the pass signal.
   *
   * SECURITY: {@link WhatsAppHttpError} carries ONLY the RESPONSE body (never
   * the request), so the `pin` — a request field — is never exposed in an error
   * message or snippet, and {@link WhatsAppNetworkError} carries only the
   * transport-failure cause. The pin is never logged here either.
   */
  async register(input: RegisterInput): Promise<void> {
    const res = await this.doFetch(
      'register',
      `${GRAPH_BASE}/${this.version}/${this.cfg.phoneNumberId}/register`,
      {
        method: 'POST',
        headers: this.authJsonHeaders(),
        body: JSON.stringify({ messaging_product: 'whatsapp', pin: input.pin }),
      },
    );
    const text = await res.text();
    if (!res.ok) {
      throw new WhatsAppHttpError('register', res.status, text);
    }
    if (!isSuccessBody(text)) {
      throw new WhatsAppHttpError('register', res.status, text);
    }
  }

  /**
   * Deregister the number (undo {@link register}). `POST
   * /{phoneNumberId}/deregister` (no body). Ported from legacy `deregister`
   * (`.old/.../api_v23/api.dart:244`).
   */
  async deregister(): Promise<void> {
    const res = await this.doFetch(
      'deregister',
      `${GRAPH_BASE}/${this.version}/${this.cfg.phoneNumberId}/deregister`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${this.cfg.accessToken}` },
      },
    );
    const text = await res.text();
    if (!res.ok) {
      throw new WhatsAppHttpError('deregister', res.status, text);
    }
    // Same pass signal as verifyCode/register (and legacy): a 2xx body must
    // carry `success: true`.
    if (!isSuccessBody(text)) {
      throw new WhatsAppHttpError('deregister', res.status, text);
    }
  }

  /**
   * Read the phone-number node's health fields (status / quality_rating /
   * code_verification_status / display_phone_number / verified_name /
   * throughput) for the account-health surface. `GET /{phoneNumberId}?fields=…`.
   * Ported from legacy `getPhoneStatus` (`.old/.../api_v23/api.dart:439`),
   * widened to the full field set. Tolerant parse: unknown enum values pass
   * through as plain strings.
   */
  async getPhoneNumberStatus(): Promise<PhoneNumberStatus> {
    const fields =
      'status,quality_rating,code_verification_status,display_phone_number,verified_name,throughput';
    const res = await this.doFetch(
      'getPhoneNumberStatus',
      `${GRAPH_BASE}/${this.version}/${this.cfg.phoneNumberId}?fields=${fields}`,
      { headers: { authorization: `Bearer ${this.cfg.accessToken}` } },
    );
    if (!res.ok) {
      const text = await res.text();
      throw new WhatsAppHttpError('getPhoneNumberStatus', res.status, text);
    }
    return phoneNumberStatusSchema.parse(await res.json());
  }

  /**
   * List the apps subscribed to the WhatsApp Business Account's webhooks —
   * the "is the webhook wired up?" health probe. `GET
   * /{wabaId}/subscribed_apps`. Ported from legacy `verifySubscription`
   * (`.old/.../api_v23/api.dart:397`). Note the arg is the WABA id (NOT the
   * phone number id). Tolerant parse of `{ data: [...] }` — a missing `data`
   * degrades to `[]`.
   */
  async getSubscribedApps(wabaId: string): Promise<SubscribedApp[]> {
    const res = await this.doFetch(
      'getSubscribedApps',
      `${GRAPH_BASE}/${this.version}/${wabaId}/subscribed_apps`,
      { headers: { authorization: `Bearer ${this.cfg.accessToken}` } },
    );
    if (!res.ok) {
      const text = await res.text();
      throw new WhatsAppHttpError('getSubscribedApps', res.status, text);
    }
    const parsed = subscribedAppsResponseSchema.parse(await res.json());
    return parsed.data ?? [];
  }
}

/**
 * Whether a Graph response body carries `success: true` (the pass signal for
 * verify_code / register). A non-JSON body counts as failure, not a throw.
 */
function isSuccessBody(text: string): boolean {
  try {
    return (JSON.parse(text) as { success?: unknown }).success === true;
  } catch (err) {
    if (err instanceof SyntaxError) return false;
    throw err;
  }
}
