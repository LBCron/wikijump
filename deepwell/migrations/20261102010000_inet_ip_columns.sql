ALTER TABLE session ALTER COLUMN ip_address TYPE INET USING ip_address::INET;
ALTER TABLE audit_log ALTER COLUMN ip_address TYPE INET USING ip_address::INET;
ALTER TABLE email_token ALTER COLUMN created_ip TYPE INET USING created_ip::INET;
