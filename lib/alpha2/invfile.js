// TODO(condition selector): exports are always "U" (used) for now, per Chris (Oct 20, 2026).
// When the used/new selector is added, return the card's or host's chosen condition here ("N" or "U").
const EXPORT_CONDITION = (_card) => "U";
// Inventory file (.bsx, BrickStore XML) writer + parts-import validation for the Paid to Sort alpha.
// Written from the published format description (BrickStoreXML.rnc); no code taken from BrickStore.
const xe = s => String(s ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const PART_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
export const validPart = p => PART_RE.test(String(p || ""));
const validColor = c => Number.isInteger(c) && c >= 0 && c <= 100000;

// Merge cards into one lot per part + color + condition (qty summed).
export function lotsFromCards(cards) {
  const m = new Map();
  for (const c of cards) {
    const part = String(c.part || "").trim(), color = +c.color || 0, qty = Math.max(0, Math.round(+c.qty || 0));
    if (!validPart(part) || !validColor(color) || !qty) continue;
    const cond = EXPORT_CONDITION(c), k = `${part}\u0000${color}\u0000${cond}`;
    const l = m.get(k) || { part, color, condition: cond, qty: 0, name: c.name || "", price: +c.price || 0 };
    l.qty += qty; if (!l.name && c.name) l.name = c.name; m.set(k, l);
  }
  return [...m.values()].sort((a, b) => a.part.localeCompare(b.part, "en", { numeric: true }) || a.color - b.color);
}

// lots: [{part, color, qty, condition?, price?, name?}], colorName: id -> name (optional)
export function inventoryXml(lots, { colorName = () => "", currency = "USD" } = {}) {
  const out = ['<?xml version="1.0" encoding="UTF-8"?>', "<BrickStoreXML>", ` <Inventory Currency="${xe(currency)}">`];
  for (const l of lots) {
    const price = Number.isFinite(+l.price) && +l.price > 0 ? (+l.price).toFixed(3) : "0";
    out.push("  <Item>", `   <ItemID>${xe(l.part)}</ItemID>`, "   <ItemTypeID>P</ItemTypeID>", `   <ColorID>${l.color | 0}</ColorID>`,
      `   <Qty>${l.qty | 0}</Qty>`, `   <Price>${price}</Price>`, `   <Condition>${l.condition === "N" ? "N" : "U"}</Condition>`);
    if (l.name) out.push(`   <ItemName>${xe(l.name)}</ItemName>`);
    const cn = colorName(l.color); if (cn && cn !== String(l.color)) out.push(`   <ColorName>${xe(cn)}</ColorName>`);
    out.push("  </Item>");
  }
  out.push(" </Inventory>", "</BrickStoreXML>", "");
  return out.join("\n");
}

// Parts import payload (already parsed client-side): {parts: [{part, name, colors: [{id, name}]}]}
export const IMPORT_LIMITS = { partsPerRequest: 500, colorsPerPart: 300, nameLen: 200, bodyBytes: 1_000_000 };
const cleanText = (s, n) => String(s ?? "").replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
export function validateImport(body) {
  const L = IMPORT_LIMITS, errs = [];
  if (!body || !Array.isArray(body.parts)) return { error: "parts list missing" };
  if (body.parts.length > L.partsPerRequest) return { error: `at most ${L.partsPerRequest} parts per request` };
  const parts = new Map(), colors = new Map();
  for (const [i, p] of body.parts.entries()) {
    const id = String(p?.part ?? "").trim();
    if (!validPart(id)) { errs.push(`row ${i + 1}: bad part number`); continue; }
    if (!Array.isArray(p.colors || [])) { errs.push(`${id}: bad colors`); continue; }
    if ((p.colors || []).length > L.colorsPerPart) { errs.push(`${id}: too many colors`); continue; }
    const e = parts.get(id) || { part: id, name: "", colors: new Set() };
    e.name = e.name || cleanText(p.name, L.nameLen);
    for (const c of p.colors || []) { const cid = Number(c?.id);
      if (!validColor(cid)) { errs.push(`${id}: bad color id`); continue; }
      e.colors.add(cid); const cn = cleanText(c?.name, 60); if (cn && !colors.has(cid)) colors.set(cid, cn); }
    parts.set(id, e);
  }
  return { parts: [...parts.values()].map(p => ({ ...p, colors: [...p.colors] })), colors, errors: errs.slice(0, 50), n_errors: errs.length };
}
