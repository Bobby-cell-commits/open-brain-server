-- Clear stale pipeline_processed entries so fixed pipeline can re-evaluate papers.
-- Must deploy AFTER the run-pipeline code fixes are live.
DELETE FROM pipeline_processed
WHERE source IN (
  'hf_papers-low',
  'hf_papers-filtered',
  'emergentmind-low',
  'emergentmind-low-temp',
  'emergentmind-hf-dedup'
);
