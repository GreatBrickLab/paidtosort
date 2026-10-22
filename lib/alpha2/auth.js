// Sign-in: PBKDF2 password hashes, HMAC-signed cookie "<user>:<ver>.<exp>.<sig>" (ver = users.token_ver; +1 signs out everywhere).
const enc = new TextEncoder(), hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
export const rnd = n => hex(crypto.getRandomValues(new Uint8Array(n)));
async function pbkdf2(pw, saltHex, it) { const k = await crypto.subtle.importKey("raw", enc.encode(pw), "PBKDF2", false, ["deriveBits"]);
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: new Uint8Array(saltHex.match(/../g).map(h => parseInt(h, 16))), iterations: it }, k, 256)); }
export async function hashPw(pw) { const s = rnd(16), it = 20000; return `pbkdf2_sha256$${it}$${s}$${await pbkdf2(pw, s, it)}`; }
export async function checkPw(pw, h) { const [, it, s, d] = String(h || "").split("$"); return !!d && (await pbkdf2(pw, s, +it)) === d; }
async function hmac(secret, msg) { const k = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]); return hex(await crypto.subtle.sign("HMAC", k, enc.encode(msg))); }
export const COOKIE = "pts2", DAYS = 14;
export async function readCookie(req, secret) {
  const m = (req.headers.get("cookie") || "").match(new RegExp(COOKIE + "=([^;]+)")); if (!m) return { why: "none" };
  const [who, exp, sig] = decodeURIComponent(m[1]).split("."); if (!sig || (await hmac(secret, who + "." + exp)) !== sig) return { why: "invalid" };
  if (+exp < Date.now()) return { why: "expired" }; const [uid, ver] = who.split(":"); return { uid: +uid, ver: +ver || 0 }; }
export async function setCookie(secret, u) { const v = `${u.id}:${+u.token_ver || 0}.${Date.now() + DAYS * 864e5}`;
  return `${COOKIE}=${encodeURIComponent(v + "." + (await hmac(secret, v)))}; Path=/alpha2; HttpOnly; Secure; SameSite=Lax; Max-Age=${DAYS * 86400}`; }
export const CLEAR = `${COOKIE}=; Path=/alpha2; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
