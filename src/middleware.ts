import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import { authConfig } from "@/auth.config";

/**
 * Edge auth instance built from the adapter-free config (C1): reading the JWT
 * session at the edge needs no database, so no native module reaches the Edge
 * bundle. Route handlers use the Node instance from `@/auth` for real work.
 */
const { auth } = NextAuth(authConfig);

/**
 * Public routes that skip the auth gate. PM Hub API routes enforce their own
 * auth downstream (Auth.js session or bot+telegram-id via getRequestUser), and
 * Auth.js's own endpoints must be reachable while signed out.
 */
const PUBLIC_ROUTES = [
  "/login",
  "/api/auth/login", // legacy password login (break-glass)
  "/api/alert",
  "/api/auth", // Auth.js (NextAuth) handlers, incl. Google callback
  "/api/spike", // PM Hub spike routes (self-authenticated)
];

export default auth((request) => {
  const { pathname } = request.nextUrl;

  const isPublic = PUBLIC_ROUTES.some(
    (route) => pathname === route || pathname.startsWith(route + "/"),
  );

  if (!isPublic) {
    // Primary: a valid Auth.js (Google) JWT session, decoded here at the edge.
    const hasAuthSession = !!request.auth;
    // Break-glass: the legacy password session cookie. Retained until the live
    // Google roundtrip is proven (pre-mortem #6); real verification still runs
    // in isAuthenticated() on the route.
    const legacy = request.cookies.get("mon_session");
    const hasLegacy = !!legacy?.value && legacy.value.length >= 64;
    // Bots authenticate per-request; the handler verifies the token itself.
    const hasBotToken =
      pathname.startsWith("/api/") && !!request.headers.get("x-bot-token");

    if (!hasAuthSession && !hasLegacy && !hasBotToken) {
      if (pathname.startsWith("/api/")) {
        return new NextResponse(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json", ...securityHeaders() },
        });
      }
      return NextResponse.redirect(new URL("/login", request.url));
    }
  }

  const response = NextResponse.next();
  for (const [key, value] of Object.entries(securityHeaders())) {
    response.headers.set(key, value);
  }
  return response;
});

function securityHeaders(): Record<string, string> {
  return {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    // img-src allows Google profile avatars from googleusercontent (NFR-SEC-7).
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://*.googleusercontent.com; font-src 'self'; connect-src 'self'; frame-ancestors 'none'",
  };
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
