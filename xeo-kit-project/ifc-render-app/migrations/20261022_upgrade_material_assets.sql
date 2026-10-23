-- Upgrade the surface material library for fabric, texture, and HEX color swatches.
-- Safe to run on a fresh install or on a database created by the earlier migration.
BEGIN;

CREATE TABLE IF NOT EXISTS public.material_assets (
    id BIGSERIAL PRIMARY KEY,
    name VARCHAR(120) NOT NULL,
    slug VARCHAR(120) NOT NULL UNIQUE,
    description TEXT,
    kind VARCHAR(16) NOT NULL,
    category VARCHAR(80) NOT NULL DEFAULT 'Tile & Surface',
    texture_url TEXT,
    color_hex CHAR(7) NOT NULL DEFAULT '#FFFFFF',
    repeat_x NUMERIC(8,3) NOT NULL DEFAULT 2,
    repeat_y NUMERIC(8,3) NOT NULL DEFAULT 2,
    roughness NUMERIC(4,3) NOT NULL DEFAULT 0.800,
    metallic NUMERIC(4,3) NOT NULL DEFAULT 0.000,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    original_filename VARCHAR(255),
    mime_type VARCHAR(64) NOT NULL DEFAULT 'image/webp',
    image_width INTEGER,
    image_height INTEGER,
    file_size_bytes BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    brand VARCHAR(120),
    collection VARCHAR(120),
    shade_code VARCHAR(80),
    source_document VARCHAR(255),
    source_page INTEGER,
    hex_source VARCHAR(32) NOT NULL DEFAULT 'manual'
);

ALTER TABLE public.material_assets
    ADD COLUMN IF NOT EXISTS brand VARCHAR(120),
    ADD COLUMN IF NOT EXISTS collection VARCHAR(120),
    ADD COLUMN IF NOT EXISTS shade_code VARCHAR(80),
    ADD COLUMN IF NOT EXISTS source_document VARCHAR(255),
    ADD COLUMN IF NOT EXISTS source_page INTEGER,
    ADD COLUMN IF NOT EXISTS hex_source VARCHAR(32) NOT NULL DEFAULT 'manual';

-- Color swatches do not require a texture file.
ALTER TABLE public.material_assets
    ALTER COLUMN texture_url DROP NOT NULL;

-- Replace the constraints so they match the current backend validation.
ALTER TABLE public.material_assets
    DROP CONSTRAINT IF EXISTS material_assets_color_hex_check,
    DROP CONSTRAINT IF EXISTS material_assets_file_size_bytes_check,
    DROP CONSTRAINT IF EXISTS material_assets_hex_source_check,
    DROP CONSTRAINT IF EXISTS material_assets_image_height_check,
    DROP CONSTRAINT IF EXISTS material_assets_image_width_check,
    DROP CONSTRAINT IF EXISTS material_assets_kind_check,
    DROP CONSTRAINT IF EXISTS material_assets_metallic_check,
    DROP CONSTRAINT IF EXISTS material_assets_repeat_x_check,
    DROP CONSTRAINT IF EXISTS material_assets_repeat_y_check,
    DROP CONSTRAINT IF EXISTS material_assets_roughness_check,
    DROP CONSTRAINT IF EXISTS material_assets_source_page_check;

ALTER TABLE public.material_assets
    ADD CONSTRAINT material_assets_color_hex_check
        CHECK (color_hex ~ '^#[0-9A-Fa-f]{6}$'),
    ADD CONSTRAINT material_assets_file_size_bytes_check
        CHECK (file_size_bytes IS NULL OR file_size_bytes > 0),
    ADD CONSTRAINT material_assets_hex_source_check
        CHECK (hex_source IN ('manual', 'sampled_from_pdf', 'manufacturer_provided')),
    ADD CONSTRAINT material_assets_image_height_check
        CHECK (image_height IS NULL OR image_height > 0),
    ADD CONSTRAINT material_assets_image_width_check
        CHECK (image_width IS NULL OR image_width > 0),
    ADD CONSTRAINT material_assets_kind_check
        CHECK (kind IN ('color', 'fabric', 'texture')),
    ADD CONSTRAINT material_assets_metallic_check
        CHECK (metallic >= 0 AND metallic <= 1),
    ADD CONSTRAINT material_assets_repeat_x_check
        CHECK (repeat_x >= 0.05 AND repeat_x <= 100),
    ADD CONSTRAINT material_assets_repeat_y_check
        CHECK (repeat_y >= 0.05 AND repeat_y <= 100),
    ADD CONSTRAINT material_assets_roughness_check
        CHECK (roughness >= 0 AND roughness <= 1),
    ADD CONSTRAINT material_assets_source_page_check
        CHECK (source_page IS NULL OR source_page > 0);

CREATE INDEX IF NOT EXISTS idx_material_assets_active_kind
    ON public.material_assets (is_active, kind, category, name);

CREATE INDEX IF NOT EXISTS idx_material_assets_palette_brand
    ON public.material_assets (is_active, kind, brand, collection, name);

COMMIT;
