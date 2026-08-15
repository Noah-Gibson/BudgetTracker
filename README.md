# Cipher Budget

A mobile-first, biweekly budget planner whose financial vault is encrypted in the browser before it is stored. The service stores ciphertext only.

## Local setup

1. Copy `.env.example` to `.env.local` and populate Google OAuth, Neon, and server-secret values.
2. Run `npm ci`.
3. Create the Neon schema with `npm run db:migrate`.
4. Run `npm run dev` and sign in with Google.

Use a real HTTPS origin for passkeys. Google OAuth needs this callback URL:

```
https://YOUR_DOMAIN/api/auth/callback/google
```

## Vercel deployment

Connect the repository to Vercel, add a Neon Postgres integration, and set `DATABASE_URL`, `AUTH_SECRET`, `NEXTAUTH_URL`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, and `AUTH_OWNER_PEPPER` in the Production environment. Set `NEXTAUTH_URL` to the exact production URL, such as `https://your-project.vercel.app`. Run the committed Drizzle migration against the production database before the first deploy.

Do not use production credentials in Preview deployments. Preview and development should each have a separate Neon database.

## Security boundary

Users must retain their offline recovery key. If both their passkey and recovery key are lost, vault data cannot be recovered. The encrypted-vault model protects a database-only compromise; it cannot protect a compromised user device, Google account, passkey, or a malicious production deployment.
