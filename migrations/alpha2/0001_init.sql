-- Paid to Sort alpha 2: lean schema. Three tables: who sorts, their sessions, and the lots in each session.
create table if not exists users(
  id integer primary key, username text not null unique, display text, pw_hash text not null,
  token_ver integer not null default 0,            -- +1 = signed out everywhere
  failed integer not null default 0, locked_until text, created text not null);
create table if not exists sessions(
  id text primary key, user_id integer not null references users(id), name text,
  started text not null, ended text, weighed_g real,              -- weighed_g: what the sorter's scale says for the whole session (optional)
  status text not null default 'open' check(status in ('open','done')));
create table if not exists lots(
  id integer primary key autoincrement, session_id text not null references sessions(id) on delete cascade,
  part text not null, name text, color integer not null default 0, qty integer not null default 1,
  confidence real, alts text, guesses text,         -- JSON: other matches [{id,name,score}], color guesses [id]
  crop text,                                        -- small JPEG data URL of the clearest photo crop (lot thumbnail)
  status text not null default 'check' check(status in ('check','ok')),   -- check = card waiting to be verified; ok = in the lot list
  created text not null, checked_at text);
create index if not exists ix_lots_sess on lots(session_id, status);
create index if not exists ix_sess_user on sessions(user_id, started);
