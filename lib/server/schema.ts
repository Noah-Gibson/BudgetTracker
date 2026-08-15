import { integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";

export const vaults = pgTable("vaults", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerHandle: varchar("owner_handle", { length: 64 }).notNull(),
  vaultId: uuid("vault_id").notNull().unique(),
  ciphertext: text("ciphertext").notNull(),
  iv: varchar("iv", { length: 32 }).notNull(),
  tag: varchar("tag", { length: 32 }).notNull(),
  recoveryWrappedKey: text("recovery_wrapped_key").notNull(),
  recoverySalt: varchar("recovery_salt", { length: 32 }).notNull(),
  revision: integer("revision").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
}, (table) => [uniqueIndex("vault_owner_handle_unique").on(table.ownerHandle)]);

export const passkeys = pgTable("passkeys", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerHandle: varchar("owner_handle", { length: 64 }).notNull(),
  credentialId: varchar("credential_id", { length: 512 }).notNull(),
  publicKey: text("public_key").notNull(),
  counter: integer("counter").notNull(),
  transports: jsonb("transports").$type<string[]>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true })
}, (table) => [uniqueIndex("passkey_credential_id_unique").on(table.credentialId)]);
