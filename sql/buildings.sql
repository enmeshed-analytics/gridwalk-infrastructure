BEGIN;

-- Materialized view for accommodation buildings
CREATE MATERIALIZED VIEW IF NOT EXISTS buildings_up_to_accommodation AS
SELECT osm_id, name, building, geom
FROM buildings
WHERE building IN ('apartments', 'barracks', 'bungalow', 'cabin', 'detached',
					'annexe', 'dormitory', 'farm', 'ger', 'hotel', 'house',
					'houseboat', 'residential', 'semidetached_house', 'static_caravan',
					'stilt_house', 'terrace', 'tree_house', 'trullo',
          'commercial', 'industrial', 'kiosk', 'office', 'retail'
					'supermarket', 'warehouse');

-- Materialized view for commercial buildings
CREATE MATERIALIZED VIEW IF NOT EXISTS buildings_up_to_commercial AS
SELECT osm_id, name, building, geom
FROM buildings
WHERE building IN ('commercial', 'industrial', 'kiosk', 'office', 'retail'
					'supermarket', 'warehouse');

-- Materialized view for all buildings
CREATE MATERIALIZED VIEW IF NOT EXISTS buildings_all AS
SELECT osm_id, name, building, geom
FROM buildings;

-- Create indexes on the materialized views for better query performance
CREATE INDEX IF NOT EXISTS idx_buildings_up_to_accommodation_geom ON buildings_up_to_accommodation USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_buildings_up_to_commercial_geom ON buildings_up_to_commercial USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_buildings_all_geom ON buildings_all USING GIST (geom);

-- Create function for tile server
CREATE OR REPLACE FUNCTION buildings_mvt(z integer, x integer, y integer)
RETURNS bytea AS $$
DECLARE
    source_table text;
    mvt bytea;
BEGIN
    -- Select the appropriate materialized view based on zoom level
    source_table := CASE
        WHEN z >= 8 THEN 'buildings_up_to_accommodation'
        WHEN z >= 5 THEN 'buildings_up_to_commercial'
        ELSE 'buildings_all'
    END;
    -- Generate MVT
    EXECUTE format('
        SELECT ST_AsMVT(tile, ''buildings'', 4096, ''geom'')
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
