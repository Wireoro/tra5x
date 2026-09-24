-- Tra5x migration 4: track which alliances hold a region, per day.
--
-- Until now, "which alliances dominate this region" (Regions tab detail dialog) was read live off the
-- latest cached map only - there was no history, so there was no way to show how an alliance's presence
-- in a region changed over the last 24h / 3d / 7d. This adds that history the same way regions themselves
-- are tracked: as more rows in the existing snapshot_breakdowns table, one per (region, alliance) per day.
--
-- No new table, no new RPC. `ingest_snapshot` already inserts whatever `kind` rows the payload sends
-- (see migration 2); the only thing stopping a new kind is the CHECK constraint, so that's all this widens.
-- Existing rows and every other kind are untouched. Like every other breakdown, history for this kind only
-- starts accumulating from whenever a server begins running this version - there is no backfill.
alter table public.snapshot_breakdowns drop constraint if exists snapshot_breakdowns_kind_check;
alter table public.snapshot_breakdowns
  add constraint snapshot_breakdowns_kind_check
  check (kind in ('pop_bucket', 'village_bucket', 'quadrant', 'ring', 'region', 'region_alliance'));
