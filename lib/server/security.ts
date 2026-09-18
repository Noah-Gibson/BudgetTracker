import { createHmac } from "node:crypto";
import { headers } from "next/headers";
import { getServerSession } from "next-auth";
import { authOptions } from "@/auth";


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
