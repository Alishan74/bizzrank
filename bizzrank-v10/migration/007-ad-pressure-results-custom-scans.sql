-- Migration 007: ad_pressure_results + custom_scans
-- Run in Supabase SQL Editor

CREATE TABLE IF NOT EXISTS ad_pressure_results (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id         uuid REFERENCES organic_scans(id) ON DELETE CASCADE,
  user_id         uuid REFERENCES profiles(id) ON DELETE CASCADE,
  business_id     uuid REFERENCES businesses(id) ON DELETE CASCADE,
  keyword         text NOT NULL,
  scan_date       date NOT NULL,
  point_index     int,
  point_label     text,
  location_name   text,
  latitude        double precision,
  longitude       double precision,
  place_id        text,
  business_name   text,
  address         text,
  rank_position   int,
  rating          double precision,
  review_count    int,
  created_at      timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ad_pressure_biz_date ON ad_pressure_results(business_id, scan_date DESC);
CREATE INDEX IF NOT EXISTS idx_ad_pressure_scan ON ad_pressure_results(scan_id);
ALTER TABLE ad_pressure_results ENABLE ROW LEVEL SECURITY;
CREATE POLICY IF NOT EXISTS "Users see own ad pressure" ON ad_pressure_results FOR ALL USING (user_id = auth.uid());

CREATE TABLE IF NOT EXISTS custom_scans (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid REFERENCES profiles(id) ON DELETE CASCADE NOT NULL,
  scan_type        text NOT NULL DEFAULT 'both' CHECK (scan_type IN ('organic','ad_pressure','both')),
  keyword          text NOT NULL,
  center_lat       double precision NOT NULL,
  center_lng       double precision NOT NULL,
  center_address   text,
  radius_km        double precision NOT NULL DEFAULT 5,
  grid_size        int NOT NULL DEFAULT 3,
  state            text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','running','completed','failed')),
  total_points     int DEFAULT 25,
  points_completed int DEFAULT 0,
  credits_consumed int DEFAULT 25,
  organic_results  jsonb,
  sponsored_results jsonb,
  visibility_score  double precision,
  scan_date        date DEFAULT CURRENT_DATE,
  created_at       timestamptz DEFAULT now(),
  completed_at     timestamptz
);
CREATE INDEX IF NOT EXISTS idx_custom_scans_user ON custom_scans(user_id, created_at DESC);
ALTER TABLE custom_scans ENABLE ROW LEVEL SECURITY;
CREATE POLICY IF NOT EXISTS "Users see own custom scans" ON custom_scans FOR ALL USING (user_id = auth.uid());

GRANT ALL ON ad_pressure_results TO service_role;
GRANT ALL ON custom_scans TO service_role;
