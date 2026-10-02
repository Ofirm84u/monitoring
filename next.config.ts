import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Deliberately no `output: "standalone"`. It was set here and never
  // exercised: production runs under pm2 as `next start`, which refuses a
  // standalone build ("next start does not work with output: standalone"), and
  // the first clean deploy that actually rebuilt the app turned that into a
  // 233-restart crash loop and a 502. Nothing else consumes the standalone
  // bundle — there is no Dockerfile or compose file in this repo. Re-adding it
  // means also pointing ecosystem.config.js at .next/standalone/server.js and
  // copying .next/static and public into place on every deploy.
  poweredByHeader: false,
  // pdf-parse uses pdfjs-dist which loads a worker via a relative file path
  // at runtime; Next.js's bundler breaks that path. Keeping the package
  // external means Node resolves the worker from node_modules at runtime.
  // better-sqlite3 is a native addon and must not be bundled; googleapis is
  // large and pure-Node, so keep it external too. (PM Hub data layer.)
  serverExternalPackages: ["pdf-parse", "pdfjs-dist", "better-sqlite3", "googleapis"],
};

export default nextConfig;
