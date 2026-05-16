import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  // pdf-parse uses pdfjs-dist which loads a worker via a relative file path
  // at runtime; Next.js's bundler breaks that path. Keeping the package
  // external means Node resolves the worker from node_modules at runtime.
  serverExternalPackages: ["pdf-parse", "pdfjs-dist"],
};

export default nextConfig;
