--
-- PostgreSQL database dump
--

\restrict gqscgD3WTWBSPhP0ShNjbq9Ig0ml6WVtXrqTVjXzjW8QIEArLeEwp7UVUbwCwuJ

-- Dumped from database version 16.14
-- Dumped by pg_dump version 16.14

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
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
-- Name: catalog_items; Type: TABLE; Schema: public; Owner: hci_user
--

CREATE TABLE public.catalog_items (
    id integer NOT NULL,
    category_id integer NOT NULL,
    name character varying(150) NOT NULL,
    slug character varying(150) NOT NULL,
    description text,
    color_rgb jsonb DEFAULT '[0.8, 0.8, 0.8]'::jsonb NOT NULL,
    thumbnail_url text,
    model_url text NOT NULL,
    file_type character varying(10) DEFAULT 'ifc'::character varying NOT NULL,
    attributes jsonb DEFAULT '{}'::jsonb NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT catalog_items_file_type_check CHECK (((file_type)::text = ANY ((ARRAY['ifc'::character varying, 'glb'::character varying])::text[])))
);


ALTER TABLE public.catalog_items OWNER TO hci_user;

--
-- Name: catalog_items_id_seq; Type: SEQUENCE; Schema: public; Owner: hci_user
--

CREATE SEQUENCE public.catalog_items_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.catalog_items_id_seq OWNER TO hci_user;

--
-- Name: catalog_items_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: hci_user
--

ALTER SEQUENCE public.catalog_items_id_seq OWNED BY public.catalog_items.id;


--
-- Name: categories; Type: TABLE; Schema: public; Owner: hci_user
--

CREATE TABLE public.categories (
    id integer NOT NULL,
    name character varying(100) NOT NULL,
    slug character varying(100) NOT NULL,
    description text,
    parent_id integer,
    image_url text,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.categories OWNER TO hci_user;

--
-- Name: categories_id_seq; Type: SEQUENCE; Schema: public; Owner: hci_user
--

CREATE SEQUENCE public.categories_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.categories_id_seq OWNER TO hci_user;

--
-- Name: categories_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: hci_user
--

ALTER SEQUENCE public.categories_id_seq OWNED BY public.categories.id;


--
-- Name: catalog_items id; Type: DEFAULT; Schema: public; Owner: hci_user
--

ALTER TABLE ONLY public.catalog_items ALTER COLUMN id SET DEFAULT nextval('public.catalog_items_id_seq'::regclass);


--
-- Name: categories id; Type: DEFAULT; Schema: public; Owner: hci_user
--

ALTER TABLE ONLY public.categories ALTER COLUMN id SET DEFAULT nextval('public.categories_id_seq'::regclass);


--
-- Data for Name: catalog_items; Type: TABLE DATA; Schema: public; Owner: hci_user
--

COPY public.catalog_items (id, category_id, name, slug, description, color_rgb, thumbnail_url, model_url, file_type, attributes, sort_order, created_at) FROM stdin;
1	3	Modern Sofa	sofa-modern	Contemporary 3-seater sofa	[0.54, 0.27, 0.07]	\N	/assets/sofa.ifc	ifc	{"seats": 3, "style": "modern"}	0	2026-08-06 13:22:31.765883+05:30
2	3	Sofa Modern V2	sofa-modern-v2	Modern sofa variant	[0.4, 0.4, 0.6]	\N	/assets/sofa_modern.ifc	ifc	{"seats": 3, "style": "modern"}	0	2026-08-06 13:22:31.769739+05:30
3	4	Chair	chair-standard	Standard dining chair	[0.6, 0.4, 0.2]	\N	/assets/chair.ifc	ifc	{"style": "dining"}	0	2026-08-06 13:22:31.770311+05:30
4	5	Cabinet	cabinet-standard	Standard storage cabinet	[0.7, 0.65, 0.55]	\N	/assets/cabinet.ifc	ifc	{"doors": 2}	0	2026-08-06 13:22:31.770898+05:30
5	5	Cabinet 4-Door	cabinet-4door	Large 4-door cabinet	[0.7, 0.65, 0.55]	\N	/assets/cabinet_4.ifc	ifc	{"doors": 4}	0	2026-08-06 13:22:31.771503+05:30
6	5	Open Bookshelf	open-bookshelf	Open display bookshelf	[0.8, 0.7, 0.5]	\N	/assets/open_bookshelf.ifc	ifc	{"shelves": 5}	0	2026-08-06 13:22:31.772129+05:30
10	7	Sink & Mirror	sink-mirror	Bathroom sink with mirror	[0.95, 0.95, 0.95]	\N	/assets/sink_mirror.ifc	ifc	{"type": "wall-mounted"}	0	2026-08-06 13:22:31.774101+05:30
11	7	Commode	commode	Bathroom commode / toilet	[0.95, 0.95, 0.95]	\N	/assets/commode.ifc	ifc	{"type": "floor-mounted"}	0	2026-08-06 13:22:31.774618+05:30
12	9	3BHK Interior Door	door-3bhk-interior	Standard interior door for 3BHK	[0.8, 0.7, 0.5]	\N	/assets/3BHK_Interior_Door.ifc	ifc	{"swing": "single"}	0	2026-08-06 13:22:31.775125+05:30
13	9	Single Flush Door	door-single-flush	Single flush door	[0.8, 0.7, 0.5]	\N	/assets/Single_Flush_Door.ifc	ifc	{"swing": "single"}	0	2026-08-06 13:22:31.775595+05:30
14	9	Double Leaf Swing Door	door-double-leaf	Double leaf swing door	[0.8, 0.7, 0.5]	\N	/assets/Double_Leaf_Swing_Door.ifc	ifc	{"swing": "double"}	0	2026-08-06 13:22:31.776075+05:30
15	9	Auto Sliding Door	door-auto-sliding	Automatic sliding door	[0.7, 0.8, 0.9]	\N	/assets/Automatic_Sliding_Door.ifc	ifc	{"mechanism": "automatic"}	0	2026-08-06 13:22:31.776588+05:30
16	9	Revolving Door	door-revolving	Commercial revolving door	[0.7, 0.8, 0.9]	\N	/assets/Revolving_Commercial_Door.ifc	ifc	{"mechanism": "revolving"}	0	2026-08-06 13:22:31.777246+05:30
17	9	Fire-Rated Door	door-fire-rated	Fire-rated safety door	[0.8, 0.3, 0.2]	\N	/assets/Fire_Rated_Door.ifc	ifc	{"fire_rating": "60min"}	0	2026-08-06 13:22:31.777941+05:30
7	5	Armoire	armoire	Large wardrobe armoire	[0.749, 0.702, 0.6]	\N	/assets/Armoire.ifc	ifc	{"doors": 2}	0	2026-08-06 13:22:31.772707+05:30
8	10	Bed (IFC)	bed-ifc	Standard double bed	[0.902, 0.851, 0.749]	\N	/assets/bed.ifc	ifc	{"size": "double"}	0	2026-08-06 13:22:31.77318+05:30
9	10	Bed (GLB)	bed-glb	High-detail bed GLB model	[0.902, 0.851, 0.749]	/uploads/catalog/thumbnails/1786018339569_xvl2pdy1r3m.jpg	/uploads/catalog/models/1786018339570_n90py4iqzwi.glb	glb	{"size": "double"}	0	2026-08-06 13:22:31.773639+05:30
18	10	Professional Bed	professional-bed	Professional Bed GLB model	[0.8, 0.8, 0.8]	/uploads/catalog/thumbnails/1786021072523_rksu5imcgc.jpg	/uploads/catalog/models/1786021072524_8948eg5kjcg.glb	glb	{}	0	2026-08-06 16:35:42.106831+05:30
\.


--
-- Data for Name: categories; Type: TABLE DATA; Schema: public; Owner: hci_user
--

COPY public.categories (id, name, slug, description, parent_id, image_url, sort_order, created_at) FROM stdin;
1	Furniture	furniture	All furniture items	\N	\N	1	2026-08-06 13:22:31.756201+05:30
2	Structural	structural	Doors, walls and structural elements	\N	\N	2	2026-08-06 13:22:31.756201+05:30
3	Sofa	sofa	Sofa and couch variants	1	\N	1	2026-08-06 13:22:31.760087+05:30
4	Seating	seating	Chairs and stools	1	\N	2	2026-08-06 13:22:31.760087+05:30
5	Storage	storage	Cabinets, wardrobes, shelves	1	\N	3	2026-08-06 13:22:31.760087+05:30
6	Bedroom	bedroom	Beds and bedroom furniture	1	\N	4	2026-08-06 13:22:31.760087+05:30
7	Bathroom	bathroom	Bathroom fixtures	1	\N	5	2026-08-06 13:22:31.760087+05:30
8	Tables	tables	Dining, center, side tables	1	\N	6	2026-08-06 13:22:31.760087+05:30
9	Doors	doors	All door types	2	\N	1	2026-08-06 13:22:31.765379+05:30
10	Double Bed	double-bed	Double Beds	6	\N	0	2026-08-06 16:09:45.093435+05:30
\.


--
-- Name: catalog_items_id_seq; Type: SEQUENCE SET; Schema: public; Owner: hci_user
--

SELECT pg_catalog.setval('public.catalog_items_id_seq', 18, true);


--
-- Name: categories_id_seq; Type: SEQUENCE SET; Schema: public; Owner: hci_user
--

SELECT pg_catalog.setval('public.categories_id_seq', 10, true);


--
-- Name: catalog_items catalog_items_pkey; Type: CONSTRAINT; Schema: public; Owner: hci_user
--

ALTER TABLE ONLY public.catalog_items
    ADD CONSTRAINT catalog_items_pkey PRIMARY KEY (id);


--
-- Name: catalog_items catalog_items_slug_key; Type: CONSTRAINT; Schema: public; Owner: hci_user
--

ALTER TABLE ONLY public.catalog_items
    ADD CONSTRAINT catalog_items_slug_key UNIQUE (slug);


--
-- Name: categories categories_pkey; Type: CONSTRAINT; Schema: public; Owner: hci_user
--

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_pkey PRIMARY KEY (id);


--
-- Name: categories categories_slug_key; Type: CONSTRAINT; Schema: public; Owner: hci_user
--

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_slug_key UNIQUE (slug);


--
-- Name: idx_categories_parent; Type: INDEX; Schema: public; Owner: hci_user
--

CREATE INDEX idx_categories_parent ON public.categories USING btree (parent_id);


--
-- Name: idx_categories_slug; Type: INDEX; Schema: public; Owner: hci_user
--

CREATE INDEX idx_categories_slug ON public.categories USING btree (slug);


--
-- Name: idx_items_category; Type: INDEX; Schema: public; Owner: hci_user
--

CREATE INDEX idx_items_category ON public.catalog_items USING btree (category_id);


--
-- Name: idx_items_slug; Type: INDEX; Schema: public; Owner: hci_user
--

CREATE INDEX idx_items_slug ON public.catalog_items USING btree (slug);


--
-- Name: catalog_items catalog_items_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: hci_user
--

ALTER TABLE ONLY public.catalog_items
    ADD CONSTRAINT catalog_items_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.categories(id) ON DELETE CASCADE;


--
-- Name: categories categories_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: hci_user
--

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.categories(id) ON DELETE CASCADE;


--
-- Name: SCHEMA public; Type: ACL; Schema: -; Owner: pg_database_owner
--

GRANT ALL ON SCHEMA public TO hci_user;


--
-- PostgreSQL database dump complete
--

\unrestrict gqscgD3WTWBSPhP0ShNjbq9Ig0ml6WVtXrqTVjXzjW8QIEArLeEwp7UVUbwCwuJ

