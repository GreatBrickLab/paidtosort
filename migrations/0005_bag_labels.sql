-- Pre-labeled bag supply (v0.4.0). Back up D1 first.
-- Back up D1 first. Each line is additive; the app also runs these at startup (lib/store_d1.js MIGRATIONS), ignoring "duplicate column".
alter table bags add column box_n integer;       -- number written on the bag within its box (1, 2, 3 ...), set when the sorter scans the bag
alter table bags add column sealed_at text;      -- when the next bag scan (or Box full) sealed it
alter table bags add column trace text;          -- admin trace: 'missing' | 'moved' | null
alter table bags add column trace_note text;
alter table bags add column trace_at text;
alter table boxes add column closed_at text;     -- set by the sorter's Box full
-- Retire the old pre-printed per-box bag QRs (unused PTS-... labels from batch-prep sheets). Run after the columns above. Idempotent.
update qrcodes set status = 'void' where status = 'issued' and session_id is null and code in (select code from bags b where b.host_id = qrcodes.host_id and b.code like 'PTS-%' and b.status = 'labelled' and b.session_id is null and coalesce(b.qty, 0) = 0 and b.box_id is not null and not exists (select 1 from cards c where c.host_id = b.host_id and c.bag_code = b.code));
update bags set status = 'void', trace = 'retired', trace_at = datetime('now') where code like 'PTS-%' and status = 'labelled' and session_id is null and coalesce(qty, 0) = 0 and box_id is not null and not exists (select 1 from cards c where c.host_id = bags.host_id and c.bag_code = bags.code);
