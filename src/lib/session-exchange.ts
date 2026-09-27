import { cookieOptions, isSameOrigin } from "./session.ts";

export type SessionUser = {
  uid: string;
  email: string | null;
  name: string | null;
  emailVerified: boolean;
  exp: number;
};

type ExchangeInput = {
  origin: string | null;
  requestUrl: string;
  requestHost?: string | null;
  idToken: unknown;
  now: number;
  secure: boolean;
  verifyUser: (idToken: string) => Promise<SessionUser>;
};

export type SessionExchangeResult =
  | {
      ok: true;
      user: SessionUser;
      cookie: {
        value: string;
        options: ReturnType<typeof cookieOptions>;
      };
    }
  | { ok: false; status: 401 | 403 };

export async function exchangeSession({
  origin,
  requestUrl,
  requestHost,
  idToken,
  now,
  secure,
  verifyUser,
}: ExchangeInput): Promise<SessionExchangeResult> {
  if (!isSameOrigin(origin, requestUrl, requestHost)) {
    return { ok: false, status: 403 };
  }
  if (typeof idToken !== "string" || !idToken) {
    return { ok: false, status: 401 };
  }

  try {
    const user = await verifyUser(idToken);
    if (!user.emailVerified || user.exp <= now) {
      return { ok: false, status: 401 };
    }
    return {
      ok: true,
      user,
      cookie: {
        value: idToken,
        options: cookieOptions(user.exp, now, secure),
      },
    };
  } catch {
    return { ok: false, status: 401 };
  }
}
