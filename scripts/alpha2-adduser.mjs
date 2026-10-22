// Prints SQL that adds (or resets) a sorter. Usage: node scripts/adduser.mjs <username> <password> [display]  > user.sql
// Then: wrangler d1 execute <db> --file user.sql (add --local for a local copy). The password is never stored, only its PBKDF2 hash.
import { pbkdf2Sync, randomBytes } from "node:crypto";
const [un, pw, display] = process.argv.slice(2);
if (!/^[a-z0-9_.-]{3,32}$/.test(un || "") || !pw || pw.length < 8) { console.error("usage: adduser.mjs <username 3-32 a-z0-9_.-> <password 8+> [display]"); process.exit(2); }
const salt = randomBytes(16).toString("hex"), it = 20000, hash = `pbkdf2_sha256$${it}$${salt}$${pbkdf2Sync(pw, Buffer.from(salt, "hex"), it, 32, "sha256").toString("hex")}`;
const q = s => "'" + String(s).replace(/'/g, "''") + "'";
console.log(`insert into users(username, display, pw_hash, created) values(${q(un)}, ${q(display || un)}, ${q(hash)}, datetime('now')) on conflict(username) do update set pw_hash = excluded.pw_hash, token_ver = token_ver + 1, failed = 0, locked_until = null;`);
