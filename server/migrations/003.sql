ALTER TABLE accounts ADD COLUMN preferred_shop_id uuid REFERENCES shops(id) ON DELETE SET NULL;
CREATE INDEX accounts_preferred_shop ON accounts(preferred_shop_id) WHERE preferred_shop_id IS NOT NULL;
