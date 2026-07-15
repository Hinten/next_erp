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
 * Media send/download helpers (image/video/audio/document/sticker,
 * `markRead` for media messages, media URL resolution) land with #527;
 * this PR only broadens the webhook parsing types (`types.ts`) and does
 * not add behavior here.
 */

export const GRAPH_BASE = 'https://graph.facebook.com';
/** Default Graph API version, overridable via `WhatsAppClientConfig.graphApiVersion`. */
export const DEFAULT_GRAPH_API_VERSION = 'v21.0';

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

export interface SendResult {
  messageId: string;
}

export class WhatsAppClient {
  constructor(private readonly cfg: WhatsAppClientConfig) {}

  private get fetcher(): typeof fetch {
    return this.cfg.fetch ?? fetch;
  }

  private get version(): string {
    return this.cfg.graphApiVersion ?? DEFAULT_GRAPH_API_VERSION;
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
    const res = await this.fetcher(
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
      throw new Error(`WhatsApp send failed (${res.status}): ${text}`);
    }
    const json = (await res.json()) as { messages?: Array<{ id: string }> };
    const id = json.messages?.[0]?.id;
    if (!id) {
      throw new Error('WhatsApp send: response missing messages[0].id');
    }
    return { messageId: id };
  }

  /**
   * Mark an inbound message as read. WhatsApp shows the blue ticks once
   * this is acknowledged.
   */
  async markRead(messageId: string): Promise<void> {
    const res = await this.fetcher(
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
      throw new Error(`WhatsApp markRead failed (${res.status}): ${text}`);
    }
  }
}
