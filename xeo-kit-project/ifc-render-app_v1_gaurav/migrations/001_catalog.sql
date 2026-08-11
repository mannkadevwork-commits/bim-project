-- ============================================================
-- 001_catalog.sql  —  Furniture Catalog Schema
-- ============================================================

CREATE TABLE IF NOT EXISTS categories (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(100) NOT NULL,
    slug        VARCHAR(100) NOT NULL UNIQUE,
    description TEXT,
    parent_id   INTEGER REFERENCES categories(id) ON DELETE CASCADE,
    image_url   TEXT,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_categories_parent ON categories(parent_id);
CREATE INDEX IF NOT EXISTS idx_categories_slug   ON categories(slug);

CREATE TABLE IF NOT EXISTS catalog_items (
    id            SERIAL PRIMARY KEY,
    category_id   INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    name          VARCHAR(150) NOT NULL,
    slug          VARCHAR(150) NOT NULL UNIQUE,
    description   TEXT,
    color_rgb     JSONB NOT NULL DEFAULT '[0.8, 0.8, 0.8]',
    thumbnail_url TEXT,
    model_url     TEXT NOT NULL,
    file_type     VARCHAR(10) NOT NULL DEFAULT 'ifc' CHECK (file_type IN ('ifc', 'glb')),
    attributes    JSONB NOT NULL DEFAULT '{}',
    sort_order    INTEGER NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_items_category ON catalog_items(category_id);
CREATE INDEX IF NOT EXISTS idx_items_slug     ON catalog_items(slug);

-- ============================================================
-- Seed root categories
-- ============================================================
INSERT INTO categories (name, slug, description, parent_id, sort_order) VALUES
    ('Furniture',  'furniture',  'All furniture items', NULL, 1),
    ('Structural', 'structural', 'Doors, walls and structural elements', NULL, 2)
ON CONFLICT (slug) DO NOTHING;

-- Sub-categories under Furniture
INSERT INTO categories (name, slug, description, parent_id, sort_order)
SELECT t.name, t.slug, t.description, (SELECT id FROM categories WHERE slug = 'furniture'), t.sort_order
FROM (VALUES
    ('Sofa',     'sofa',     'Sofa and couch variants',       1),
    ('Seating',  'seating',  'Chairs and stools',             2),
    ('Storage',  'storage',  'Cabinets, wardrobes, shelves',  3),
    ('Bedroom',  'bedroom',  'Beds and bedroom furniture',    4),
    ('Bathroom', 'bathroom', 'Bathroom fixtures',             5),
    ('Tables',   'tables',   'Dining, center, side tables',   6)
) AS t(name, slug, description, sort_order)
ON CONFLICT (slug) DO NOTHING;

-- Sub-category under Structural
INSERT INTO categories (name, slug, description, parent_id, sort_order)
SELECT 'Doors', 'doors', 'All door types', (SELECT id FROM categories WHERE slug = 'structural'), 1
ON CONFLICT (slug) DO NOTHING;

-- ============================================================
-- Seed items from existing /assets files
-- ============================================================

-- Sofas
INSERT INTO catalog_items (category_id, name, slug, description, color_rgb, model_url, file_type, attributes)
SELECT id, 'Modern Sofa', 'sofa-modern', 'Contemporary 3-seater sofa',
       '[0.54, 0.27, 0.07]', '/assets/sofa.ifc', 'ifc', '{"seats": 3, "style": "modern"}'
FROM categories WHERE slug = 'sofa' ON CONFLICT (slug) DO NOTHING;

INSERT INTO catalog_items (category_id, name, slug, description, color_rgb, model_url, file_type, attributes)
SELECT id, 'Sofa Modern V2', 'sofa-modern-v2', 'Modern sofa variant',
       '[0.4, 0.4, 0.6]', '/assets/sofa_modern.ifc', 'ifc', '{"seats": 3, "style": "modern"}'
FROM categories WHERE slug = 'sofa' ON CONFLICT (slug) DO NOTHING;

-- Seating
INSERT INTO catalog_items (category_id, name, slug, description, color_rgb, model_url, file_type, attributes)
SELECT id, 'Chair', 'chair-standard', 'Standard dining chair',
       '[0.6, 0.4, 0.2]', '/assets/chair.ifc', 'ifc', '{"style": "dining"}'
FROM categories WHERE slug = 'seating' ON CONFLICT (slug) DO NOTHING;

-- Storage
INSERT INTO catalog_items (category_id, name, slug, description, color_rgb, model_url, file_type, attributes)
SELECT id, 'Cabinet', 'cabinet-standard', 'Standard storage cabinet',
       '[0.7, 0.65, 0.55]', '/assets/cabinet.ifc', 'ifc', '{"doors": 2}'
FROM categories WHERE slug = 'storage' ON CONFLICT (slug) DO NOTHING;

INSERT INTO catalog_items (category_id, name, slug, description, color_rgb, model_url, file_type, attributes)
SELECT id, 'Cabinet 4-Door', 'cabinet-4door', 'Large 4-door cabinet',
       '[0.7, 0.65, 0.55]', '/assets/cabinet_4.ifc', 'ifc', '{"doors": 4}'
FROM categories WHERE slug = 'storage' ON CONFLICT (slug) DO NOTHING;

INSERT INTO catalog_items (category_id, name, slug, description, color_rgb, model_url, file_type, attributes)
SELECT id, 'Open Bookshelf', 'open-bookshelf', 'Open display bookshelf',
       '[0.8, 0.7, 0.5]', '/assets/open_bookshelf.ifc', 'ifc', '{"shelves": 5}'
FROM categories WHERE slug = 'storage' ON CONFLICT (slug) DO NOTHING;

INSERT INTO catalog_items (category_id, name, slug, description, color_rgb, model_url, file_type, attributes)
SELECT id, 'Armoire', 'armoire', 'Large wardrobe armoire',
       '[0.75, 0.7, 0.6]', '/assets/Armoire.ifc', 'ifc', '{"doors": 2}'
FROM categories WHERE slug = 'storage' ON CONFLICT (slug) DO NOTHING;

-- Bedroom
INSERT INTO catalog_items (category_id, name, slug, description, color_rgb, model_url, file_type, attributes)
SELECT id, 'Bed (IFC)', 'bed-ifc', 'Standard double bed',
       '[0.9, 0.85, 0.75]', '/assets/bed.ifc', 'ifc', '{"size": "double"}'
FROM categories WHERE slug = 'bedroom' ON CONFLICT (slug) DO NOTHING;

INSERT INTO catalog_items (category_id, name, slug, description, color_rgb, model_url, file_type, attributes)
SELECT id, 'Bed (GLB)', 'bed-glb', 'High-detail bed GLB model',
       '[0.9, 0.85, 0.75]', '/assets/Bed.glb', 'glb', '{"size": "double"}'
FROM categories WHERE slug = 'bedroom' ON CONFLICT (slug) DO NOTHING;

-- Bathroom
INSERT INTO catalog_items (category_id, name, slug, description, color_rgb, model_url, file_type, attributes)
SELECT id, 'Sink & Mirror', 'sink-mirror', 'Bathroom sink with mirror',
       '[0.95, 0.95, 0.95]', '/assets/sink_mirror.ifc', 'ifc', '{"type": "wall-mounted"}'
FROM categories WHERE slug = 'bathroom' ON CONFLICT (slug) DO NOTHING;

INSERT INTO catalog_items (category_id, name, slug, description, color_rgb, model_url, file_type, attributes)
SELECT id, 'Commode', 'commode', 'Bathroom commode / toilet',
       '[0.95, 0.95, 0.95]', '/assets/commode.ifc', 'ifc', '{"type": "floor-mounted"}'
FROM categories WHERE slug = 'bathroom' ON CONFLICT (slug) DO NOTHING;

-- Doors
INSERT INTO catalog_items (category_id, name, slug, description, color_rgb, model_url, file_type, attributes)
SELECT id, '3BHK Interior Door', 'door-3bhk-interior', 'Standard interior door for 3BHK',
       '[0.8, 0.7, 0.5]', '/assets/3BHK_Interior_Door.ifc', 'ifc', '{"swing": "single"}'
FROM categories WHERE slug = 'doors' ON CONFLICT (slug) DO NOTHING;

INSERT INTO catalog_items (category_id, name, slug, description, color_rgb, model_url, file_type, attributes)
SELECT id, 'Single Flush Door', 'door-single-flush', 'Single flush door',
       '[0.8, 0.7, 0.5]', '/assets/Single_Flush_Door.ifc', 'ifc', '{"swing": "single"}'
FROM categories WHERE slug = 'doors' ON CONFLICT (slug) DO NOTHING;

INSERT INTO catalog_items (category_id, name, slug, description, color_rgb, model_url, file_type, attributes)
SELECT id, 'Double Leaf Swing Door', 'door-double-leaf', 'Double leaf swing door',
       '[0.8, 0.7, 0.5]', '/assets/Double_Leaf_Swing_Door.ifc', 'ifc', '{"swing": "double"}'
FROM categories WHERE slug = 'doors' ON CONFLICT (slug) DO NOTHING;

INSERT INTO catalog_items (category_id, name, slug, description, color_rgb, model_url, file_type, attributes)
SELECT id, 'Auto Sliding Door', 'door-auto-sliding', 'Automatic sliding door',
       '[0.7, 0.8, 0.9]', '/assets/Automatic_Sliding_Door.ifc', 'ifc', '{"mechanism": "automatic"}'
FROM categories WHERE slug = 'doors' ON CONFLICT (slug) DO NOTHING;

INSERT INTO catalog_items (category_id, name, slug, description, color_rgb, model_url, file_type, attributes)
SELECT id, 'Revolving Door', 'door-revolving', 'Commercial revolving door',
       '[0.7, 0.8, 0.9]', '/assets/Revolving_Commercial_Door.ifc', 'ifc', '{"mechanism": "revolving"}'
FROM categories WHERE slug = 'doors' ON CONFLICT (slug) DO NOTHING;

INSERT INTO catalog_items (category_id, name, slug, description, color_rgb, model_url, file_type, attributes)
SELECT id, 'Fire-Rated Door', 'door-fire-rated', 'Fire-rated safety door',
       '[0.8, 0.3, 0.2]', '/assets/Fire_Rated_Door.ifc', 'ifc', '{"fire_rating": "60min"}'
FROM categories WHERE slug = 'doors' ON CONFLICT (slug) DO NOTHING;
