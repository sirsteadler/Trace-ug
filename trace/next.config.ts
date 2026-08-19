import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pinned explicitly. Next infers the workspace root by walking up for a
  // lockfile and finds an unrelated one in the user's home directory, which
  // silently changes what gets traced into the build.
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
