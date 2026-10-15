/**
 * #1431: one raw-digest HMAC primitive behind an explicit server-only subpath.
 * Providers own their manifests, header parsing and missing-secret policies.
 */
export { verifyHmac, type HmacVerifyInput } from './hmac';
