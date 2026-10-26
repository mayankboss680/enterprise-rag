import type { NextConfig } from "next";

const nextConfig: NextConfig = {

  serverExternalPackages: ["@xenova/transformers", "onnxruntime-node"],
  /* config options here */
  experimental: {
    agentFeedback: true,
  },
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
