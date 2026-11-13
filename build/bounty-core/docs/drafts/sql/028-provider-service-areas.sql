-- 028-provider-service-areas.sql (DRAFT)
CREATE TABLE IF NOT EXISTS provider_service_areas (
  user_id           UUID PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
  area_label        VARCHAR(120) NOT NULL CHECK (char_length(area_label) BETWEEN 1 AND 120),
  base_lat          NUMERIC(9,6) NOT NULL CHECK (base_lat BETWEEN -90 AND 90),
  base_lng          NUMERIC(9,6) NOT NULL CHECK (base_lng BETWEEN -180 AND 180),
  radius_km         SMALLINT NOT NULL CHECK (radius_km BETWEEN 1 AND 200),
  willing_to_travel BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_provider_service_areas_coords
  ON provider_service_areas (base_lat, base_lng);
