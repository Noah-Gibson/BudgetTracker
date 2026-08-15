import type { NextAuthOptions } from "next-auth";
import GoogleProvider from "next-auth/providers/google";

export const authOptions: NextAuthOptions = {
  secret: process.env.AUTH_SECRET,
  providers: [GoogleProvider({
    clientId: process.env.AUTH_GOOGLE_ID ?? "",
    clientSecret: process.env.AUTH_GOOGLE_SECRET ?? ""
  })],
  session: { strategy: "jwt", maxAge: 60 * 60, updateAge: 10 * 60 },
  callbacks: {
    session({ session, token }) {
      if (session.user && token.sub) session.user.id = token.sub;
      return session;
    }
  },
  pages: { signIn: "/" }
};
