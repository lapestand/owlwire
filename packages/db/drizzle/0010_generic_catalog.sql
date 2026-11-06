-- Custom SQL migration file, put your code below! --
INSERT INTO catalog_types (app_id, key, name, description, default_severity, payload_schema, created_at, updated_at)
SELECT a.id, 'generic', 'Generic', 'Plain notifications sent via /v1/hooks', 'info', NULL, now(), now()
FROM apps a
ON CONFLICT (app_id, key) DO NOTHING;
