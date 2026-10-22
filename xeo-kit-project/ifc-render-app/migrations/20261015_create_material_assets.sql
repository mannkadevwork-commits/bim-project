-- Surface material library: reusable fabric, tile and texture assets.
-- Run once against the application's PostgreSQL database before starting the updated API.
BEGIN;

CREATE TABLE IF NOT EXISTS material_assets (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  slug VARCHAR(120) NOT NULL UNIQUE,
  description TEXT,
  kind VARCHAR(16) NOT NULL CHECK (kind IN ('fabric', 'texture')),
  category VARCHAR(80) NOT NULL DEFAULT 'Tile & Surface',
  texture_url TEXT NOT NULL,
  color_hex CHAR(7) NOT NULL DEFAULT '#FFFFFF' CHECK (color_hex ~ '^#[0-9A-Fa-f]{6}$'),
  repeat_x NUMERIC(8,3) NOT NULL DEFAULT 2 CHECK (repeat_x >= 0.05 AND repeat_x <= 100),
  repeat_y NUMERIC(8,3) NOT NULL DEFAULT 2 CHECK (repeat_y >= 0.05 AND repeat_y <= 100),
  roughness NUMERIC(4,3) NOT NULL DEFAULT 0.800 CHECK (roughness >= 0 AND roughness <= 1),
  metallic NUMERIC(4,3) NOT NULL DEFAULT 0.000 CHECK (metallic >= 0 AND metallic <= 1),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  original_filename VARCHAR(255),
  mime_type VARCHAR(64) NOT NULL DEFAULT 'image/webp',
  image_width INTEGER CHECK (image_width IS NULL OR image_width > 0),
  image_height INTEGER CHECK (image_height IS NULL OR image_height > 0),
  file_size_bytes BIGINT CHECK (file_size_bytes IS NULL OR file_size_bytes > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_material_assets_active_kind
  ON material_assets (is_active, kind, category, name);

COMMIT;
