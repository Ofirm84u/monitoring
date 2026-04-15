import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Public routes that don't require authentication
const PUBLIC_ROUTES = ["/login", "/api/auth/login", "/api/alert"];

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Allow public routes through
  const isPublic = PUBLIC_ROUTES.some(
    (route) => pathname === route || pathname.startsWith(route + "/"),
  );

  if (!isPublic) {
    // Check session cookie exists and has a value
    // (full cryptographic verification happens in isAuthenticated() on API routes)
    const session = request.cookies.get("mon_session");
    if (!session?.value || session.value.length < 64) {
      if (pathname.startsWith("/api/")) {
        return new NextResponse(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: {
            "Content-Type": "application/json",
            ...securityHeaders(),
          },
        });
      }
      return NextResponse.redirect(new URL("/login", request.url));
    }
  }

  // Add security headers to all responses
  const response = NextResponse.next();
  const headers = securityHeaders();
  for (const [key, value] of Object.entries(headers)) {
    response.headers.set(key, value);
  }

  return response;
}

function securityHeaders(): Record<string, string> {
  return {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'",
  };
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
