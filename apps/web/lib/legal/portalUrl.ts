export function resolvePortalUrl(
  configuredUrl: string | undefined,
  environment: string | undefined,
): string | null {
  const value = configuredUrl?.trim();
  if (value) {
    // Only HTTP origins: a malformed deployment value must not become a script URL.
    const parsed = URL.canParse(value) ? new URL(value) : null;
    if (parsed && (parsed.protocol === 'https:' || parsed.protocol === 'http:')) {
      if (
        parsed.username ||
        parsed.password ||
        parsed.search ||
        parsed.hash ||
        parsed.pathname !== '/'
      ) {
        return null;
      }
      return parsed.origin;
    }
    return null;
  }
  return environment === 'development' ? 'http://localhost:3002' : null;
}
