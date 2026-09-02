import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Served under /cabinet2/ on the existing domain (no DNS access yet for a
  // real subdomain) — nginx proxies that whole path prefix to this app's own
  // port; basePath makes every route/asset/link inside the app resolve
  // under it automatically, without touching any of the copied page code.
  basePath: "/cabinet2",
};

export default nextConfig;
