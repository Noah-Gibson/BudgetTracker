import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { database } from "@/lib/server/db";
import { vaults } from "@/lib/server/schema";
import { requireOwner, requireSameOrigin, requireStepUp } from "@/lib/server/security";
import { rateLimit } from "@/lib/server/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const b64 = z.string().regex(/^[A-Za-z0-9_-]+$/).max(250_000);
const writeSchema = z.object({ vaultId: z.string().uuid(), revision: z.number().int().positive(), ciphertext: b64, iv: z.string().regex(/^[A-Za-z0-9_-]{16}$/), tag: z.string().regex(/^[A-Za-z0-9_-]{22}$/), recoveryWrappedKey: z.string().min(20).max(500), recoverySalt: z.string().regex(/^[A-Za-z0-9_-]{22}$/) });

export async function GET() {
  const owner = await requireOwner(); if (!rateLimit(`vault-read:${owner}`, 80)) return NextResponse.json({ error: "Too many requests" }, { status: 429 }); await requireStepUp(owner);
  const value = await database().query.vaults.findFirst({ where: eq(vaults.ownerHandle, owner) });
  return NextResponse.json({ vault: value ?? null }, { headers: { "Cache-Control": "no-store" } });
}

export async function PUT(request: Request) {
  await requireSameOrigin(); const owner = await requireOwner(); if (!rateLimit(`vault-write:${owner}`, 40)) return NextResponse.json({ error: "Too many requests" }, { status: 429 }); await requireStepUp(owner);
  const input = writeSchema.parse(await request.json()); const db = database();
  const existing = await db.query.vaults.findFirst({ where: eq(vaults.ownerHandle, owner) });
  if (existing && input.revision !== existing.revision + 1) return NextResponse.json({ error: "revision_conflict", revision: existing.revision }, { status: 409 });
  if (!existing) {
    if (input.revision !== 1) return NextResponse.json({ error: "revision_conflict", revision: 0 }, { status: 409 });
    const inserted = await db.insert(vaults).values({ ownerHandle: owner, vaultId: input.vaultId, ciphertext: input.ciphertext, iv: input.iv, tag: input.tag, recoveryWrappedKey: input.recoveryWrappedKey, recoverySalt: input.recoverySalt, revision: 1 }).onConflictDoNothing({ target: vaults.ownerHandle }).returning({ revision: vaults.revision });
    // A concurrent first-save may have won between the read above and this
    // insert. Report it as a conflict instead of acknowledging a write that
    // did not happen.
    if (!inserted.length) return NextResponse.json({ error: "revision_conflict", revision: 1 }, { status: 409 });
  } else {
    const updated = await db.update(vaults).set({ ciphertext: input.ciphertext, iv: input.iv, tag: input.tag, recoveryWrappedKey: input.recoveryWrappedKey, recoverySalt: input.recoverySalt, revision: input.revision, updatedAt: new Date() }).where(and(eq(vaults.ownerHandle, owner), eq(vaults.revision, existing.revision))).returning({ revision: vaults.revision });
    if (!updated.length) return NextResponse.json({ error: "revision_conflict", revision: existing.revision }, { status: 409 });
  }
  return NextResponse.json({ revision: input.revision }, { headers: { "Cache-Control": "no-store" } });
}

export async function DELETE() {
  await requireSameOrigin(); const owner = await requireOwner(); if (!rateLimit(`vault-delete:${owner}`, 10)) return NextResponse.json({ error: "Too many requests" }, { status: 429 }); await requireStepUp(owner);
  await database().delete(vaults).where(eq(vaults.ownerHandle, owner));
  return new Response(null, { status: 204 });
}
