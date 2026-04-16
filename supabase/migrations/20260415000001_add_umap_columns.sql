-- Add UMAP 2D projection columns for embedding map visualization
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS umap_x float8;
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS umap_y float8;
