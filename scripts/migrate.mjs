import { existsSync } from "node:fs";
import dotenv from "dotenv";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { migrate } from "drizzle-orm/neon-http/migrator";

// Vercel injects production variables. Locally, load the untracked development
// file without printing its contents.
if (existsSync(".env.local")) dotenv.config({ path: ".env.local", quiet: true });

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required to run database migrations.");
}

// The HTTP driver works locally without a WebSocket constructor and uses the
// same connection path as the application itself.
const db = drizzle({ client: neon(process.env.DATABASE_URL) });
await migrate(db, { migrationsFolder: "drizzle" });
console.log("Database migrations are current.");
