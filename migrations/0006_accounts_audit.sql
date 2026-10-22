-- Accounts and admin audit log (v0.5 design, Oct 21 2026). Applied to live Oct 21 2026 (v0.5.0).
-- Back up D1 first. Each statement is additive; the app also runs these at startup (lib/store_d1.js MIGRATIONS), ignoring "duplicate column".
alter table users add column status text not null default 'active';       -- 'active' | 'disabled' (admin turned the account off)
alter table users add column token_ver integer not null default 0;        -- sign-in version in the cookie: +1 = every phone signed out (log out everywhere, admin kill switch, password change/reset, turned off)
alter table users add column failed_logins integer not null default 0;    -- wrong passwords in a row
alter table users add column locked_until text;                           -- sign-in locked until (UTC) after 5 wrong passwords, 15 minutes
alter table users add column prep_only integer not null default 0;        -- 1 = prep helper: a sorter who may also do batch prep, box/bag labels and bag lookup
alter table users add column pw_changed text;                             -- when the password was last changed or reset
alter table hosts add column contact_note text;                           -- what stuck sorters see under "Contact your host" (host-written, optional)
create table if not exists audit(host_id integer not null, id integer not null, at text not null, user_id integer, username text, action text not null, target text, detail text, primary key(host_id, id));
create index if not exists ix_audit_at on audit(host_id, at);
