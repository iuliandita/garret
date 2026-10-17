CREATE TABLE figure_asset (
  id          TEXT PRIMARY KEY,
  stored_name TEXT NOT NULL UNIQUE,
  mime        TEXT NOT NULL,
  bytes       INTEGER NOT NULL,
  sha256      TEXT NOT NULL,
  width_px    INTEGER NOT NULL,
  height_px   INTEGER NOT NULL,
  orientation INTEGER NOT NULL
);
