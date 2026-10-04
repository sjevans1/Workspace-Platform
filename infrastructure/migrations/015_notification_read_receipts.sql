-- W12b: optional per-recipient read receipt for authorized in-app notifications.
-- Historical items remain unread until the recipient explicitly acknowledges.
ALTER TABLE notifications ADD COLUMN read_at timestamptz;
CREATE INDEX notifications_user_read_at
  ON notifications(tenant_id,user_id,read_at,created_at DESC,id);
