import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { verifyAuthenticationResponse, verifyRegistrationResponse, type AuthenticationResponseJSON, type RegistrationResponseJSON } from "@simplewebauthn/server";
import { z } from "zod";
import { database } from "@/lib/server/db";
import { passkeys } from "@/lib/server/schema";
import { consumeChallenge, issueStepUp, requireOwner, requireSameOrigin } from "@/lib/server/security";
import { rateLimit } from "@/lib/server/rate-limit";

export const runtime = "nodejs";
const requestSchema = z.object({ mode: z.enum(["registration", "authentication"]), response: z.unknown() });
const b64 = (value: Uint8Array) => Buffer.from(value).toString("base64url");
function origin(request: Request) { const value = request.headers.get("origin"); if (!value) throw new Response("Missing origin", { status: 400 }); return value; }
function rp(request: Request) { const host = request.headers.get("host"); if (!host) throw new Response("Missing host", { status: 400 }); return host.split(":")[0]; }

export async function POST(request: Request) {
  await requireSameOrigin(); const owner = await requireOwner(); if (!rateLimit(`passkey-verify:${owner}`, 12)) return NextResponse.json({ error: "Too many requests" }, { status: 429 }); const input = requestSchema.parse(await request.json());
  const challenge = await consumeChallenge(owner, input.mode); const expectedOrigin = origin(request); const expectedRPID = rp(request); const db = database();
  if (input.mode === "registration") {
    const verification = await verifyRegistrationResponse({ response: input.response as RegistrationResponseJSON, expectedChallenge: challenge, expectedOrigin, expectedRPID, requireUserVerification: true });
    if (!verification.verified || !verification.registrationInfo) return NextResponse.json({ error: "Passkey registration failed" }, { status: 400 });
    const credential = verification.registrationInfo.credential;
    await db.insert(passkeys).values({ ownerHandle: owner, credentialId: credential.id, publicKey: b64(credential.publicKey), counter: credential.counter, transports: credential.transports ?? null });
    return NextResponse.json({ verified: true });
  }
  const response = input.response as AuthenticationResponseJSON;
  const existing = await db.query.passkeys.findFirst({ where: and(eq(passkeys.ownerHandle, owner), eq(passkeys.credentialId, response.id)) });
  if (!existing) return NextResponse.json({ error: "Unknown passkey" }, { status: 400 });
  const verification = await verifyAuthenticationResponse({ response, expectedChallenge: challenge, expectedOrigin, expectedRPID, requireUserVerification: true, credential: { id: existing.credentialId, publicKey: new Uint8Array(Buffer.from(existing.publicKey, "base64url")), counter: existing.counter, transports: existing.transports as never } });
  if (!verification.verified) return NextResponse.json({ error: "Passkey verification failed" }, { status: 400 });
  await db.update(passkeys).set({ counter: verification.authenticationInfo.newCounter, lastUsedAt: new Date() }).where(eq(passkeys.id, existing.id));
  await issueStepUp(owner);
  return NextResponse.json({ verified: true }, { headers: { "Cache-Control": "no-store" } });
}
