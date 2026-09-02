import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // /cabinet2 was the staging path while this ran side-by-side with the old
  // hand-built cabinet for review. Now the real cabinet — old one retired,
  // nginx's /cabinet/ points here instead of the old static site.
  basePath: "/cabinet",
};

export default nextConfig;
