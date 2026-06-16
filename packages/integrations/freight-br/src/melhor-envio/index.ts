/**
 * Melhor Envio core — platform-neutral, fetch-based OAuth + API. Used
 * server-side by `apps/integrations` (it touches `client_secret` and
 * persists tokens). `firebase-admin` stays out — the Firestore
 * `TokenStore` is injected by the consumer.
 */
export * from './types';
export * from './errors';
export * from './oauth';
export * from './token-store';
export * from './api';
export * from './calculate';
