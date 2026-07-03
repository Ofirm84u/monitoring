import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  // pdf-parse uses pdfjs-dist which loads a worker via a relative file path
  // at runtime; Next.js's bundler breaks that path. Keeping the package
  // external means Node resolves the worker from node_modules at runtime.
  // better-sqlite3 is a native addon and must not be bundled; googleapis is
  // large and pure-Node, so keep it external too. (PM Hub data layer.)
  serverExternalPackages: ["pdf-parse", "pdfjs-dist", "better-sqlite3", "googleapis"],
};

export default nextConfig;
