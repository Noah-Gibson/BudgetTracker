import { createHmac, randomUUID } from "node:crypto";
import { cookies, headers } from "next/headers";
import { SignJWT, jwtVerify } from "jose";
import { getServerSession } from "next-auth";
import { authOptions } from "@/auth";

const isProduction = process.env.NODE_ENV === "production";
const stepUpCookie = isProduction ? "__Host-cipher-budget-step-up" : "cipher-budget-step-up";
const challengeCookie = isProduction ? "__Host-cipher-budget-challenge" : "cipher-budget-challenge";
const secret = () => new TextEncoder().encode(process.env.AUTH_SECRET ?? "development-only-secret-change-me");
const secureCookie = (maxAge: number) => ({ httpOnly: true, secure: isProduction, sameSite: "strict" as const, path: "/", maxAge });

export async function requireOwner() {
  const session = await getServerSession(authOptions);
  const subject = session?.user?.id;
  if (!subject) throw new Response("Authentication required", { status: 401 });
  const pepper = process.env.AUTH_OWNER_PEPPER;
  if (!pepper) throw new Response("Server security is not configured", { status: 503 });
  return createHmac("sha256", pepper).update(subject).digest("hex");
}

export async function requireSameOrigin() {
  const requestHeaders = await headers();
  const origin = requestHeaders.get("origin"); const host = requestHeaders.get("host");
  if (!origin || !host || new URL(origin).host !== host) throw new Response("Invalid request origin", { status: 403 });
}

export async function issueStepUp(ownerHandle: string) {
  const token = await new SignJWT({ ownerHandle, type: "passkey-step-up" }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("15m").setJti(randomUUID()).sign(secret());
  const jar = await cookies();
  jar.set(stepUpCookie, token, secureCookie(15 * 60));
}

export async function requireStepUp(ownerHandle: string) {
  const token = (await cookies()).get(stepUpCookie)?.value;
  if (!token) throw new Response("Passkey verification required", { status: 403 });
  try {
    const { payload } = await jwtVerify(token, secret());
    if (payload.type !== "passkey-step-up" || payload.ownerHandle !== ownerHandle) throw new Error("Mismatch");
  } catch { throw new Response("Passkey verification required", { status: 403 }); }
}

// `cookies().delete(name)` omits Secure on its Set-Cookie response. That is
// invalid for a __Host- cookie, so expire it with the same host-cookie
// attributes used when issuing it.
export async function clearStepUp() { (await cookies()).set(stepUpCookie, "", secureCookie(0)); }

export async function issueChallenge(ownerHandle: string, challenge: string, mode: "registration" | "authentication") {
  const token = await new SignJWT({ ownerHandle, challenge, mode, type: "webauthn-challenge" }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("5m").sign(secret());
  (await cookies()).set(challengeCookie, token, secureCookie(5 * 60));
}

export async function consumeChallenge(ownerHandle: string, mode: "registration" | "authentication") {
  const jar = await cookies(); const token = jar.get(challengeCookie)?.value; jar.set(challengeCookie, "", secureCookie(0));
  if (!token) throw new Response("Passkey challenge expired", { status: 400 });
  try {
    const { payload } = await jwtVerify(token, secret());
    if (payload.type !== "webauthn-challenge" || payload.ownerHandle !== ownerHandle || payload.mode !== mode || typeof payload.challenge !== "string") throw new Error("Mismatch");
    return payload.challenge;
  } catch { throw new Response("Passkey challenge expired", { status: 400 }); }
}
