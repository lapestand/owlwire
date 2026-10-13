-- New connections are sealed with the workspace DEK (dek_v1). Rows that existed before 0001 were backfilled
-- with kek_v0 by that migration's column default and keep it until upgradeLegacyConnectionSecrets runs.
ALTER TABLE "connections" ALTER COLUMN "config_enc_scheme" SET DEFAULT 'dek_v1';
