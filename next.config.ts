import type { NextConfig } from "next";
const nextConfig: NextConfig = {
  poweredByHeader: false,
  async redirects() {
    // The upload summary moved into /budget; Next preserves the query string.
    return [{ source: "/summary", destination: "/budget", permanent: false }];
  },
};
export default nextConfig;
