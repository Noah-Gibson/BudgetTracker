import { spawnSync } from "node:child_process";

const node = process.execPath;
const run = (file, args) => {
  const result = spawnSync(node, [file, ...args], { stdio: "inherit", env: process.env });
  if (result.status !== 0) process.exit(result.status ?? 1);
};

// Preview deployments never alter a database. Production migrations are idempotent through
// Drizzle's migration journal and run before the application bundle is deployed.
if (process.env.VERCEL_ENV === "production") run("scripts/migrate.mjs", []);
run("node_modules/next/dist/bin/next", ["build"]);
