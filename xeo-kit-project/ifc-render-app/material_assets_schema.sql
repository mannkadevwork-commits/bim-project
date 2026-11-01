--
-- PostgreSQL database dump
--

\restrict OTPk6LdIDixeQYmvwQ9hphM7LBef2ZFDByRRBObGIbOM0Nx8nYI6BXFFPfjpbk2

-- Dumped from database version 18.6
-- Dumped by pg_dump version 18.6

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: material_assets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.material_assets (
    id bigint NOT NULL,
    name character varying(120) NOT NULL,
    slug character varying(120) NOT NULL,
    description text,
    kind character varying(16) NOT NULL,
    category character varying(80) DEFAULT 'Tile & Surface'::character varying NOT NULL,
    texture_url text,
    color_hex character(7) DEFAULT '#FFFFFF'::bpchar NOT NULL,
    repeat_x numeric(8,3) DEFAULT 2 NOT NULL,
    repeat_y numeric(8,3) DEFAULT 2 NOT NULL,
    roughness numeric(4,3) DEFAULT 0.800 NOT NULL,
    metallic numeric(4,3) DEFAULT 0.000 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    original_filename character varying(255),
    mime_type character varying(64) DEFAULT 'image/webp'::character varying NOT NULL,
    image_width integer,
    image_height integer,
    file_size_bytes bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    brand character varying(120),
    collection character varying(120),
    shade_code character varying(80),
    source_document character varying(255),
    source_page integer,
    hex_source character varying(32) DEFAULT 'manual'::character varying NOT NULL,
    CONSTRAINT material_assets_color_hex_check CHECK ((color_hex ~ '^#[0-9A-Fa-f]{6}$'::text)),
    CONSTRAINT material_assets_file_size_bytes_check CHECK (((file_size_bytes IS NULL) OR (file_size_bytes > 0))),
    CONSTRAINT material_assets_hex_source_check CHECK (((hex_source)::text = ANY ((ARRAY['manual'::character varying, 'sampled_from_pdf'::character varying, 'manufacturer_provided'::character varying])::text[]))),
    CONSTRAINT material_assets_image_height_check CHECK (((image_height IS NULL) OR (image_height > 0))),
    CONSTRAINT material_assets_image_width_check CHECK (((image_width IS NULL) OR (image_width > 0))),
    CONSTRAINT material_assets_kind_check CHECK (((kind)::text = ANY ((ARRAY['color'::character varying, 'fabric'::character varying, 'texture'::character varying])::text[]))),
    CONSTRAINT material_assets_metallic_check CHECK (((metallic >= (0)::numeric) AND (metallic <= (1)::numeric))),
    CONSTRAINT material_assets_repeat_x_check CHECK (((repeat_x >= 0.05) AND (repeat_x <= (100)::numeric))),
    CONSTRAINT material_assets_repeat_y_check CHECK (((repeat_y >= 0.05) AND (repeat_y <= (100)::numeric))),
    CONSTRAINT material_assets_roughness_check CHECK (((roughness >= (0)::numeric) AND (roughness <= (1)::numeric))),
    CONSTRAINT material_assets_source_page_check CHECK (((source_page IS NULL) OR (source_page > 0)))
);


--
-- Name: material_assets_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.material_assets_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: material_assets_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.material_assets_id_seq OWNED BY public.material_assets.id;


--
-- Name: material_assets id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.material_assets ALTER COLUMN id SET DEFAULT nextval('public.material_assets_id_seq'::regclass);


--
-- Name: material_assets material_assets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.material_assets
    ADD CONSTRAINT material_assets_pkey PRIMARY KEY (id);


--
-- Name: material_assets material_assets_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.material_assets
    ADD CONSTRAINT material_assets_slug_key UNIQUE (slug);


--
-- Name: idx_material_assets_active_kind; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_material_assets_active_kind ON public.material_assets USING btree (is_active, kind, category, name);


--
-- Name: idx_material_assets_palette_brand; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_material_assets_palette_brand ON public.material_assets USING btree (is_active, kind, brand, collection, name);


--
-- PostgreSQL database dump complete
--

\unrestrict OTPk6LdIDixeQYmvwQ9hphM7LBef2ZFDByRRBObGIbOM0Nx8nYI6BXFFPfjpbk2

