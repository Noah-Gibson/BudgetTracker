# Cipher Budget

A mobile-first, biweekly budget planner whose financial vault is encrypted in the browser before it is stored. The service stores ciphertext only.

## Local setup

1. Copy `.env.example` to `.env.local` and populate Google OAuth, Neon, and server-secret values. Set `NEXT_PUBLIC_GOOGLE_DRIVE_CLIENT_ID` to the same Web OAuth client ID as `AUTH_GOOGLE_ID`.
2. Run `npm ci`.
3. Create the Neon schema with `npm run db:migrate`.
4. Run `npm run dev` and sign in with Google.

Use a real HTTPS origin for passkeys. Google OAuth needs this callback URL:

```
https://YOUR_DOMAIN/api/auth/callback/google
```

## Vercel deployment

Connect the repository to Vercel, add a Neon Postgres integration, and set `DATABASE_URL`, `AUTH_SECRET`, `NEXTAUTH_URL`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `NEXT_PUBLIC_GOOGLE_DRIVE_CLIENT_ID`, and `AUTH_OWNER_PEPPER` in the Production environment. Set `NEXTAUTH_URL` to the exact production URL, such as `https://your-project.vercel.app`. In the same Google Cloud project, enable the Google Drive API and add `https://www.googleapis.com/auth/drive.appdata` on the Google Auth Platform **Data Access** page. Add the production URL to that Web OAuth client’s authorized JavaScript origins. Run the committed Drizzle migration against the production database before the first deploy.

Do not use production credentials in Preview deployments. Preview and development should each have a separate Neon database.

## Security boundary

Google Drive backup is the standard recovery option. The browser sends its recovery package directly to the user's hidden Google Drive app-data folder; the application server never receives a Drive token or recovery secret. Users can instead use the advanced manual recovery key option. A user who began with a manual key can later select **Use Google Drive recovery** in the unlocked budget and replace it with a newly generated Drive-stored recovery secret; after the encrypted vault update succeeds, the old manual key no longer unlocks that vault. If both available recovery methods and the passkey are lost, vault data cannot be recovered. The encrypted-vault model protects against application-server and database access; a Drive-backed vault also trusts the user's Google account to safeguard its recovery package.
