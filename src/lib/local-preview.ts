export function allowLocalPreview(
  env: { NODE_ENV?: string; GRIDLENS_LOCAL_PREVIEW?: string },
  host: string | null,
  forwardedHost: string | null,
): boolean {
  const loopback = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i;
  return env.NODE_ENV === "development" && env.GRIDLENS_LOCAL_PREVIEW === "1" &&
    !!host && loopback.test(host) && (!forwardedHost || loopback.test(forwardedHost));
}
