// Parts file reader (.bsx / BrickStore XML), runs in the browser. Written from the published format description.
// Returns {parts: [{part, name, colors: [{id, name}]}], items, skipped}. Only ItemTypeID "P" (parts) is used.
(function () {
  const LIMITS = { bytes: 5 * 1024 * 1024, items: 20000 };
  function parse(text) {
    if (text.length > LIMITS.bytes) throw new Error("File is larger than 5 MB.");
    if (/<!DOCTYPE[^>]*\[|<!ENTITY/i.test(text)) throw new Error("File contains entity declarations, which are not allowed.");
    const doc = new DOMParser().parseFromString(text, "application/xml");
    if (doc.getElementsByTagName("parsererror").length) throw new Error("Not a valid XML file.");
    const root = doc.documentElement;
    if (!root || !["BrickStoreXML", "BrickStockXML"].includes(root.nodeName)) throw new Error("Not an inventory file (unexpected root element).");
    const inv = [...root.children].find(e => e.nodeName === "Inventory"); if (!inv) throw new Error("No inventory found in the file.");
    const items = [...inv.children].filter(e => e.nodeName === "Item");
    if (items.length > LIMITS.items) throw new Error(`Too many items (${items.length}); the limit is ${LIMITS.items}.`);
    const by = new Map(); let skipped = 0;
    for (const it of items) {
      const f = k => { const e = [...it.children].find(x => x.nodeName === k); return e ? e.textContent.trim() : ""; };
      const part = f("ItemID"), type = f("ItemTypeID") || "P", cid = f("ColorID");
      if (type !== "P" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(part) || !/^\d{1,6}$/.test(cid)) { skipped++; continue; }
      const p = by.get(part) || { part, name: "", colors: new Map() };
      p.name = p.name || f("ItemName").slice(0, 200);
      if (!p.colors.has(+cid)) p.colors.set(+cid, f("ColorName").slice(0, 60));
      by.set(part, p);
    }
    return { parts: [...by.values()].map(p => ({ part: p.part, name: p.name, colors: [...p.colors].map(([id, name]) => ({ id, name })) })), items: items.length, skipped };
  }
  window.PTSInvFile = { parse, LIMITS };
})();
