import type { NextAuthOptions } from "next-auth";
import GoogleProvider from "next-auth/providers/google";

// A personal installed web app should remain signed in like a native app.
// This is deliberately long-lived rather than idle-expiring; clearing site
// data or explicitly signing out still ends it.
const REMEMBERED_SESSION_MAX_AGE = 60 * 60 * 24 * 365 * 10;

export const authOptions: NextAuthOptions = {
  secret: process.env.AUTH_SECRET,
  providers: [GoogleProvider({
    clientId: process.env.AUTH_GOOGLE_ID ?? "",
    clientSecret: process.env.AUTH_GOOGLE_SECRET ?? ""
  })],
  session: { strategy: "jwt", maxAge: REMEMBERED_SESSION_MAX_AGE, updateAge: 24 * 60 * 60 },
  callbacks: {
    session({ session, token }) {
      if (session.user && token.sub) session.user.id = token.sub;
      return session;
    }
  },
  pages: { signIn: "/" }
};
