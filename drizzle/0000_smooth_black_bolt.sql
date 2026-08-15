CREATE TABLE "passkeys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_handle" varchar(64) NOT NULL,
	"credential_id" varchar(512) NOT NULL,
	"public_key" text NOT NULL,
	"counter" integer NOT NULL,
	"transports" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "vaults" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_handle" varchar(64) NOT NULL,
	"vault_id" uuid NOT NULL,
	"ciphertext" text NOT NULL,
	"iv" varchar(32) NOT NULL,
	"tag" varchar(32) NOT NULL,
	"recovery_wrapped_key" text NOT NULL,
	"recovery_salt" varchar(32) NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vaults_vault_id_unique" UNIQUE("vault_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "passkey_credential_id_unique" ON "passkeys" USING btree ("credential_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vault_owner_handle_unique" ON "vaults" USING btree ("owner_handle");