CREATE TABLE figure_asset (
  id          TEXT NOT NULL PRIMARY KEY CHECK (length(id) > 0),
  stored_name TEXT NOT NULL UNIQUE CHECK (length(stored_name) > 0),
  mime        TEXT NOT NULL CHECK (mime IN ('image/png', 'image/jpeg')),
  bytes       INTEGER NOT NULL CHECK (typeof(bytes) = 'integer' AND bytes BETWEEN 1 AND 16777216),
  sha256      TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  width_px    INTEGER NOT NULL CHECK (typeof(width_px) = 'integer' AND width_px BETWEEN 1 AND 50000000),
  height_px   INTEGER NOT NULL CHECK (typeof(height_px) = 'integer' AND height_px BETWEEN 1 AND 50000000),
  orientation INTEGER NOT NULL CHECK (orientation BETWEEN 1 AND 8),
  CHECK (width_px * height_px <= 50000000)
);

CREATE TRIGGER figure_asset_no_update BEFORE UPDATE ON figure_asset
BEGIN
  SELECT RAISE(ABORT, 'figure registry rows are immutable');
END;
CREATE TRIGGER figure_asset_no_delete BEFORE DELETE ON figure_asset
BEGIN
  SELECT RAISE(ABORT, 'figure registry rows are immutable');
END;
