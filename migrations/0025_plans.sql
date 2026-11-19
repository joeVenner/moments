-- Hosting plans. A plan's state follows the rules in src/worker/plans.ts;
-- App Store records (subscriptions, transactions, notifications) come with
-- the step that fills them. Dates are "YYYY-MM-DD HH:MM:SS" UTC like the
-- rest of the schema.

-- What can be bought. `app_store_product_id` is filled in by a later
-- migration (UPDATE) once the products exist in App Store Connect, so the
-- ids there can still be chosen freely.
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('subscription', 'consumable')),
  -- Subscriptions only: higher is bigger (decides upgrade vs downgrade).
  tier_rank INTEGER,
  -- Subscriptions only: guests per event before the +10% grace.
  guest_cap INTEGER,
  app_store_product_id TEXT,
  CHECK ((kind = 'subscription') = (tier_rank IS NOT NULL AND guest_cap IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_products_app_store_product_id ON products (app_store_product_id);

INSERT OR IGNORE INTO products (id, kind, tier_rank, guest_cap) VALUES
  ('host_50', 'subscription', 1, 50),
  ('host_150', 'subscription', 2, 150),
  ('host_300', 'subscription', 3, 300),
  ('host_600', 'subscription', 4, 600),
  ('extra_event', 'consumable', NULL, NULL);

-- One hosting term. A user has at most one plan that isn't purged;
-- re-subscribing before the purge restores that same row.
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  state TEXT NOT NULL CHECK (state IN ('active', 'canceling', 'grace', 'billing_retry', 'lapsed', 'revoked', 'purged')),
  product_id TEXT NOT NULL REFERENCES products(id),
  pending_product_id TEXT REFERENCES products(id),
  started_at TEXT NOT NULL,
  test_window_ends_at TEXT NOT NULL,
  period_ends_at TEXT NOT NULL,
  grace_ends_at TEXT,
  readonly_until TEXT,
  -- Bumped on every write: a save based on an older read fails instead of
  -- overwriting a newer state (two App Store notices at once).
  version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_plans_one_live_per_user ON plans (user_id) WHERE state != 'purged';

-- The events a plan pays for: a main event comes with every plan, the test
-- event only with a host's first plan, and each "Extra event" purchase adds
-- a main one. Creating an event uses one up (from the host's own live plan).
CREATE TABLE IF NOT EXISTS event_allowances (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plans(id),
  kind TEXT NOT NULL CHECK (kind IN ('test', 'main')),
  source TEXT NOT NULL CHECK (source IN ('included', 'addon')),
  -- The Extra event purchase; one allowance per transaction.
  transaction_id TEXT,
  consumed_event_id TEXT REFERENCES events(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK ((source = 'addon') = (transaction_id IS NOT NULL)),
  -- An Extra event is always a main event.
  CHECK (source = 'included' OR kind = 'main')
);
CREATE INDEX IF NOT EXISTS idx_event_allowances_plan_id ON event_allowances (plan_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_event_allowances_transaction_id ON event_allowances (transaction_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_event_allowances_consumed_event_id ON event_allowances (consumed_event_id);
