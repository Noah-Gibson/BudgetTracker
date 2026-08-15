import { NextResponse, type NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  const nonce = crypto.randomUUID().replace(/-/g, "");
  // Next.js development tooling uses eval for source maps and Fast Refresh. Keep
  // this exception local-only; the deployed application never receives it.
  const scriptSrc = [
    "script-src 'self' https://accounts.google.com/gsi/client https://va.vercel-scripts.com",
    `'nonce-${nonce}'`,
    process.env.NODE_ENV === "development" ? "'unsafe-eval'" : ""
  ].filter(Boolean).join(" ");
  const csp = [
    "default-src 'self'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style",
    "img-src 'self' data: blob: https://*.googleusercontent.com",
    "font-src 'self' data:",
    "connect-src 'self' https://accounts.google.com https://www.googleapis.com https://vitals.vercel-insights.com",
    "frame-src https://accounts.google.com/gsi/",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'"
  ].join("; ");
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  // Supplying the nonce in the request CSP lets Next attach it to its generated
  // scripts. Send the same policy to the browser for actual enforcement.
  requestHeaders.set("Content-Security-Policy", csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } }); response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
