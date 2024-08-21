BEGIN;

-- Create materialized views
CREATE MATERIALIZED VIEW IF NOT EXISTS roads_all AS
SELECT osm_id, name, highway, geom
FROM roads;

CREATE MATERIALIZED VIEW IF NOT EXISTS roads_up_to_residential AS
SELECT osm_id, name, highway, ST_Simplify(geom, 10) AS geom
FROM roads
WHERE highway IN ('motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential');

CREATE MATERIALIZED VIEW IF NOT EXISTS roads_up_to_secondary AS
SELECT osm_id, name, highway, ST_Simplify(geom, 50) AS geom
FROM roads
WHERE highway IN ('motorway', 'trunk', 'primary', 'secondary');

CREATE MATERIALIZED VIEW IF NOT EXISTS roads_up_to_trunk AS
SELECT osm_id, name, highway, ST_Simplify(geom, 200) AS geom
FROM roads
WHERE highway IN ('motorway', 'trunk');

CREATE MATERIALIZED VIEW IF NOT EXISTS roads_motorways AS
SELECT osm_id, name, highway, ST_Simplify(geom, 500) AS geom
FROM roads
WHERE highway = 'motorway';

-- Create indexes on the materialized views
CREATE INDEX IF NOT EXISTS roads_all_geom_idx ON roads_all USING GIST (geom);
CREATE INDEX IF NOT EXISTS roads_up_to_residential_geom_idx ON roads_up_to_residential USING GIST (geom);
CREATE INDEX IF NOT EXISTS roads_up_to_secondary_geom_idx ON roads_up_to_secondary USING GIST (geom);
CREATE INDEX IF NOT EXISTS roads_up_to_trunk_geom_idx ON roads_up_to_trunk USING GIST (geom);
CREATE INDEX IF NOT EXISTS roads_motorways_geom_idx ON roads_motorways USING GIST (geom);

-- Create function for tile server
CREATE OR REPLACE FUNCTION roads_mvt(z integer, x integer, y integer)
RETURNS bytea AS $$
DECLARE
    source_table text;
    mvt bytea;
BEGIN
    -- Select the appropriate materialized view based on zoom level
    source_table := CASE
        WHEN z >= 9 THEN 'roads_all'
        WHEN z >= 8 THEN 'roads_up_to_secondary'
        WHEN z >= 5 THEN 'roads_up_to_trunk'
        ELSE 'roads_motorways'
    END;
    -- Generate MVT
    EXECUTE format('
        SELECT ST_AsMVT(tile, ''roads'', 4096, ''geom'')
        FROM (
            SELECT
                osm_id,
                name,
                highway,
                ST_AsMVTGeom(
                    geom,
                    ST_TileEnvelope(%s, %s, %s),
                    4096, 64, true
                ) AS geom
            FROM %I
            WHERE geom && ST_TileEnvelope(%s, %s, %s)
        ) AS tile
        WHERE geom IS NOT NULL',
        z, x, y, source_table, z, x, y
    ) INTO mvt;
    RETURN mvt;
END;
$$ LANGUAGE plpgsql STABLE PARALLEL SAFE;

COMMIT;
