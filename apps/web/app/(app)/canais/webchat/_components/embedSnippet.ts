/**
 * Pure builder for the "Gerar Script Webchat" bulk action's embed snippet.
 * Kept out of the `'use client'` modal so it is unit-testable without Mantine.
 *
 * The snippet targets `apps/webchat/public/loader.js`'s documented usage
 * (`data-tenant` + optional `data-widget-url`) — the widget itself resolves
 * `<tenant>` to a `webchat/<id>` doc.
 */

const DEFAULT_WEBCHAT_URL = 'http://localhost:3002';

/** Origin of the hosted webchat widget — see `.env.example`. */
export function webchatWidgetUrl(): string {
  return process.env.NEXT_PUBLIC_WEBCHAT_URL ?? DEFAULT_WEBCHAT_URL;
}

/**
 * The plain, copy-pasteable `<script>` embed tag for a given `webchat` doc id.
 * `widgetUrl` defaults to {@link webchatWidgetUrl}; a caller may override it
 * for tests or a doc-specific `url` override in the future.
 */
export function buildEmbedScript(docId: string, widgetUrl: string = webchatWidgetUrl()): string {
  const normalizedBase = widgetUrl.endsWith('/') ? widgetUrl : `${widgetUrl}/`;
  return (
    `<script\n` +
    `  src="${normalizedBase}loader.js"\n` +
    `  data-tenant="${docId}"\n` +
    `  data-widget-url="${normalizedBase}"\n` +
    `  async\n` +
    `></script>`
  );
}

/**
 * Base64 encoding of {@link buildEmbedScript}'s output. The snippet is always
 * plain ASCII (a Firestore doc id plus fixed markup), so a Latin1-only
 * encoder (`btoa`) is safe — no UTF-8 dance needed.
 */
export function buildEmbedScriptBase64(
  docId: string,
  widgetUrl: string = webchatWidgetUrl(),
): string {
  const script = buildEmbedScript(docId, widgetUrl);
  if (typeof window !== 'undefined' && typeof window.btoa === 'function') {
    return window.btoa(script);
  }
  return Buffer.from(script, 'utf-8').toString('base64');
}
