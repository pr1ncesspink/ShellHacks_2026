export const SESSION_COOKIE = "__session";

const DEFAULT_NEXT = "/dashboard";
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const ENCODED_UNSAFE_CHARACTER = /%(?:0[0-9a-f]|1[0-9a-f]|7f|2f|5c)/i;
const PROTECTED_PATHS = ["/dashboard", "/budget", "/profile"] as const;

export function cookieOptions(exp: number, now: number, secure: boolean) {
  return {
    httpOnly: true,
    secure,
    sameSite: "lax" as const,
    path: "/",
    maxAge: Math.max(0, Math.floor(exp - now)),
  };
}

/** Secure cookies only over HTTPS, so `npm start` on plain http still keeps its session. */
export function isSecureRequest(requestUrl: string): boolean {
  try {
    return new URL(requestUrl).protocol === "https:";
  } catch {
    return false;
  }
}

export function isProtectedPath(pathname: string): boolean {
  return PROTECTED_PATHS.some(
    (path) => pathname === path || pathname.startsWith(`${path}/`),
  );
}

export function safeNext(value: string | null | undefined): string {
  if (!value) return DEFAULT_NEXT;
  if (value !== value.trim()) return DEFAULT_NEXT;
  if (!value.startsWith("/") || value.startsWith("//")) return DEFAULT_NEXT;
  if (value.includes("\\") || CONTROL_CHARACTERS.test(value)) return DEFAULT_NEXT;
  if (ENCODED_UNSAFE_CHARACTER.test(value)) return DEFAULT_NEXT;

  let decoded = value;
  try {
    for (let pass = 0; pass < 8; pass += 1) {
      const nextDecoded = decodeURIComponent(decoded);
      if (nextDecoded === decoded) break;
      decoded = nextDecoded;
      if (
        decoded.startsWith("//") ||
        decoded.includes("\\") ||
        CONTROL_CHARACTERS.test(decoded)
      ) {
        return DEFAULT_NEXT;
      }
    }
    if (ENCODED_UNSAFE_CHARACTER.test(decoded)) return DEFAULT_NEXT;
  } catch {
    return DEFAULT_NEXT;
  }

  try {
    const base = new URL("https://gridlens.invalid");
    const target = new URL(value, base);
    if (target.origin !== base.origin || !target.pathname.startsWith("/")) {
      return DEFAULT_NEXT;
    }
  } catch {
    return DEFAULT_NEXT;
  }

  return value;
}

export function isSameOrigin(
  originHeader: string | null | undefined,
  requestUrl: string,
  hostHeader?: string | null,
): boolean {
  if (!originHeader || originHeader === "null") return false;
  try {
    const supplied = new URL(originHeader);
    const expected = new URL(requestUrl);
    if (hostHeader) {
      const external = new URL(`${expected.protocol}//${hostHeader}`);
      if (
        external.pathname !== "/" ||
        external.search ||
        external.hash ||
        external.username ||
        external.password
      ) {
        return false;
      }
      expected.host = external.host;
    }
    return supplied.origin === originHeader && supplied.origin === expected.origin;
  } catch {
    return false;
  }
}
