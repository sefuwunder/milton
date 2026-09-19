// hookauth.ts — shared secret verification for Milton's incoming webhook endpoints.
// Both /api/hooks/exec-crm and /api/hooks/meridian follow the same pattern:
// 503 when MILTON_HOOK_SECRET isn't configured, 401 on a bad X-Milton-Secret,
// constant-time comparison. Env is read at call time so tests can reconfigure.

/** The configured hook secret, or "" when unset. */
export function hookSecret(): string {
  return process.env.MILTON_HOOK_SECRET || "";
}

/** True when `given` matches the configured secret. False when no secret is set. */
export function verifyHookSecret(given: string): boolean {
  const secret = hookSecret();
  if (!secret) return false;
  const a = new TextEncoder().encode(given || "");
  const b = new TextEncoder().encode(secret);
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] || 0) ^ (b[i] || 0);
  return diff === 0;
}
