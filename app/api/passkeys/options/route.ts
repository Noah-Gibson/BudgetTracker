import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { generateAuthenticationOptions, generateRegistrationOptions } from "@simplewebauthn/server";
import { z } from "zod";
import { database } from "@/lib/server/db";
import { passkeys } from "@/lib/server/schema";
import { issueChallenge, requireOwner, requireSameOrigin } from "@/lib/server/security";
import { rateLimit } from "@/lib/server/rate-limit";

export const runtime = "nodejs";
const requestSchema = z.object({ mode: z.enum(["registration", "authentication"]), prfSalt: z.string().regex(/^[A-Za-z0-9_-]{22}$/).optional() });

function rp(request: Request) { const host = request.headers.get("host"); if (!host) throw new Response("Missing host", { status: 400 }); return host.split(":")[0]; }

export async function POST(request: Request) {
  await requireSameOrigin(); const owner = await requireOwner(); if (!rateLimit(`passkey-options:${owner}`, 10)) return NextResponse.json({ error: "Too many requests" }, { status: 429 }); const { mode, prfSalt } = requestSchema.parse(await request.json());
  const rpID = rp(request); const db = database(); const credentials = await db.select().from(passkeys).where(eq(passkeys.ownerHandle, owner));
  const prf = prfSalt ? { prf: { eval: { first: new Uint8Array(Buffer.from(prfSalt, "base64url")) } } } : undefined;
  const options = mode === "registration"
    ? await generateRegistrationOptions({ rpName: "Cipher Budget", rpID, userName: owner, userDisplayName: "Cipher Budget user", userID: new TextEncoder().encode(owner), attestationType: "none", authenticatorSelection: { residentKey: "required", userVerification: "required" }, excludeCredentials: credentials.map((item) => ({ id: item.credentialId, transports: item.transports as never })) })
    : await generateAuthenticationOptions({
      rpID,
      userVerification: "required",
      // Stored transports are only WebAuthn routing hints. A password-manager
      // extension can reject a valid synced passkey when an old internal hint
      // is present, so identify the credential without constraining transport.
      allowCredentials: credentials.map((item) => ({ id: item.credentialId })),
      extensions: prf as never
    });
  await issueChallenge(owner, options.challenge, mode);
  return NextResponse.json(options, { headers: { "Cache-Control": "no-store" } });
}
