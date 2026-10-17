import { Hono } from "hono";
import { cors } from "hono/cors";

type Env = { DB: D1Database; BASE_RPC: string; PUBLIC_URL: string };
const app = new Hono<{ Bindings: Env }>();
app.use("*", cors());

const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const EVM = /^0x[0-9a-fA-F]{40}$/;

const now = () => Date.now();
const rid = (n = 10) => {
  const a = "abcdefghijkmnpqrstuvwxyz23456789";
  const b = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(b, (x) => a[x % a.length]).join("");
};
async function sha256(s: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}
const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "stall";
const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const atomicToUsd = (a: string) => (Number(BigInt(a)) / 1e6).toFixed(6);
// Works for any contact a seller gives: email, phone (opens WhatsApp, which works worldwide) or a link.
const contactLink = (contact: string, text: string) => {
  const c = String(contact ?? "").trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c)) return `mailto:${c}?subject=${encodeURIComponent("New order")}&body=${encodeURIComponent(text)}`;
  if (/^https?:\/\//i.test(c)) return c;
  const digits = c.replace(/[^0-9]/g, "");
  if (digits.length >= 7) return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
  return "";
};
const err = (c: any, status: number, message: string) => c.json({ error: message }, status);

const RPCS = ["https://base-rpc.publicnode.com", "https://base.drpc.org", "https://mainnet.base.org", "https://base.gateway.tenderly.co"];
async function rpc(env: Env, method: string, params: unknown[]) {
  let last = "rpc unavailable";
  for (const url of [env.BASE_RPC, ...RPCS.filter((u) => u !== env.BASE_RPC)]) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(3000),
      });
      const j: any = await r.json();
      if (j.error || j.result === undefined) { last = j.error?.message ?? `bad response from ${url}`; continue; }
      return j.result;
    } catch (e: any) { last = e.message; }
  }
  throw new Error(last);
}

async function stallAuth(env: Env, slug: string, key: string) {
  const s: any = await env.DB.prepare("SELECT * FROM stalls WHERE slug = ?").bind(slug).first();
  if (!s) return null;
  if (s.edit_key_hash !== (await sha256(key ?? ""))) return null;
  return s;
}

function publicProduct(p: any, s?: any) {
  return {
    product_id: p.id,
    title: p.title,
    description: p.description ?? "",
    price_usd: (p.price_cents / 100).toFixed(2),
    stock: p.stock,
    photo_url: p.photo_url ?? "",
    stall: s ? { slug: s.slug, name: s.name, city: s.city ?? "" } : undefined,
  };
}

app.get("/", (c) => c.json({ ok: true, service: "stall", docs: "Agent-shoppable stalls for WhatsApp & Instagram sellers" }));

// ---------- seller ----------
app.post("/stalls", async (c) => {
  const b: any = await c.req.json();
  const contact = b.contact ?? b.whatsapp;
  if (!b.name || !contact || !EVM.test(b.wallet ?? "")) return err(c, 400, "shop name, a contact (phone, email or link) and a valid 0x payout wallet are required");
  let slug = slugify(b.name);
  if (await c.env.DB.prepare("SELECT 1 FROM stalls WHERE slug = ?").bind(slug).first()) slug = `${slug}-${rid(4)}`;
  const key = `sk_${rid(20)}`;
  const id = rid();
  await c.env.DB.prepare(
    "INSERT INTO stalls (id, slug, name, whatsapp, wallet, city, bio, edit_key_hash, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
  ).bind(id, slug, b.name, contact, b.wallet.toLowerCase(), b.city ?? null, b.bio ?? null, await sha256(key), now()).run();
  return c.json({ slug, edit_key: key, share_url: `${c.env.PUBLIC_URL}/s/${slug}` });
});

app.post("/stalls/:slug/products", async (c) => {
  const b: any = await c.req.json();
  const s = await stallAuth(c.env, c.req.param("slug"), b.edit_key);
  if (!s) return err(c, 403, "unknown stall or wrong edit key");
  const cents = Math.round(Number(b.price_usd) * 100);
  if (!b.title || !(cents > 0)) return err(c, 400, "title and positive price_usd required");
  const id = `p_${rid(8)}`;
  await c.env.DB.prepare(
    "INSERT INTO products (id, stall_id, title, description, price_cents, stock, photo_url, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
  ).bind(id, s.id, b.title, b.description ?? null, cents, Math.max(0, Number(b.stock ?? 1) | 0), b.photo_url ?? null, now(), now()).run();
  const p = await c.env.DB.prepare("SELECT * FROM products WHERE id = ?").bind(id).first();
  return c.json({ product: publicProduct(p, s) });
});

app.patch("/stalls/:slug/products/:pid", async (c) => {
  const b: any = await c.req.json();
  const s = await stallAuth(c.env, c.req.param("slug"), b.edit_key);
  if (!s) return err(c, 403, "unknown stall or wrong edit key");
  const p: any = await c.env.DB.prepare("SELECT * FROM products WHERE id = ? AND stall_id = ?").bind(c.req.param("pid"), s.id).first();
  if (!p) return err(c, 404, "product not found in this stall");
  const cents = b.price_usd !== undefined ? Math.round(Number(b.price_usd) * 100) : p.price_cents;
  if (!(cents > 0)) return err(c, 400, "price must be positive");
  await c.env.DB.prepare("UPDATE products SET title = ?, price_cents = ?, stock = ?, updated_at = ? WHERE id = ?")
    .bind(b.title ?? p.title, cents, b.stock !== undefined ? Math.max(0, Number(b.stock) | 0) : p.stock, now(), p.id).run();
  const np = await c.env.DB.prepare("SELECT * FROM products WHERE id = ?").bind(p.id).first();
  const watchers: any = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM watches WHERE max_cents >= ? AND (product_id = ? OR (product_id IS NULL AND ? LIKE '%' || query || '%'))",
  ).bind(cents, p.id, `${np!.title} ${np!.description ?? ""}`.toLowerCase()).first();
  return c.json({ product: publicProduct(np, s), watchers_now_matching: watchers?.n ?? 0 });
});

app.post("/stalls/:slug/orders", async (c) => {
  const b: any = await c.req.json();
  const s = await stallAuth(c.env, c.req.param("slug"), b.edit_key);
  if (!s) return err(c, 403, "unknown stall or wrong edit key");
  const { results } = await c.env.DB.prepare(
    "SELECT o.*, p.title FROM orders o JOIN products p ON p.id = o.product_id WHERE o.stall_id = ? ORDER BY o.created_at DESC LIMIT 25",
  ).bind(s.id).all();
  return c.json({
    orders: results.map((o: any) => ({
      order_id: o.id, product: o.title, qty: o.qty, amount_usdc: atomicToUsd(o.amount_atomic),
      status: o.status, delivery_note: o.note ?? "", buyer_contact: o.contact ?? "", tx_hash: o.tx_hash ?? "",
    })),
  });
});

// ---------- buyer ----------
app.get("/search", async (c) => {
  const q = (c.req.query("q") ?? "").trim().toLowerCase();
  const max = c.req.query("max_usd") ? Math.round(Number(c.req.query("max_usd")) * 100) : 1e12;
  const city = (c.req.query("city") ?? "").trim().toLowerCase();
  const words = q.split(/\s+/).filter(Boolean).slice(0, 5);
  let sql = "SELECT p.*, s.slug, s.name AS sname, s.city FROM products p JOIN stalls s ON s.id = p.stall_id WHERE p.stock > 0 AND p.price_cents <= ?";
  const args: unknown[] = [max];
  for (const w of words) { sql += " AND lower(p.title || ' ' || coalesce(p.description,'') || ' ' || s.name) LIKE ?"; args.push(`%${w}%`); }
  if (city) { sql += " AND lower(coalesce(s.city,'')) LIKE ?"; args.push(`%${city}%`); }
  sql += " ORDER BY p.price_cents ASC LIMIT 20";
  const { results } = await c.env.DB.prepare(sql).bind(...args).all();
  return c.json({ results: results.map((p: any) => publicProduct(p, { slug: p.slug, name: p.sname, city: p.city })) });
});

app.get("/stalls/:slug", async (c) => {
  const s: any = await c.env.DB.prepare("SELECT * FROM stalls WHERE slug = ?").bind(c.req.param("slug")).first();
  if (!s) return err(c, 404, "stall not found");
  const { results } = await c.env.DB.prepare("SELECT * FROM products WHERE stall_id = ? ORDER BY created_at DESC").bind(s.id).all();
  return c.json({
    stall: { slug: s.slug, name: s.name, city: s.city ?? "", bio: s.bio ?? "", contact_link: contactLink(s.whatsapp, `Hi ${s.name}!`) },
    products: results.map((p) => publicProduct(p)),
  });
});

app.post("/orders", async (c) => {
  const b: any = await c.req.json();
  const p: any = await c.env.DB.prepare("SELECT * FROM products WHERE id = ?").bind(b.product_id).first();
  if (!p) return err(c, 404, "product not found");
  const qty = Math.max(1, Number(b.qty ?? 1) | 0);
  if (p.stock < qty) return err(c, 409, `only ${p.stock} left in stock`);
  const s: any = await c.env.DB.prepare("SELECT * FROM stalls WHERE id = ?").bind(p.stall_id).first();
  // Unique amount: price plus a sub-cent tag so a plain USDC transfer identifies the order.
  const tag = BigInt(1 + (crypto.getRandomValues(new Uint16Array(1))[0] % 9999));
  const amount = BigInt(p.price_cents) * BigInt(qty) * 10000n + tag;
  let startBlock = 0;
  try { startBlock = Number(BigInt(await rpc(c.env, "eth_blockNumber", []))); } catch {}
  const id = `o_${rid(8)}`;
  await c.env.DB.prepare(
    "INSERT INTO orders (id, product_id, stall_id, qty, amount_atomic, note, contact, start_block, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
  ).bind(id, p.id, s.id, qty, amount.toString(), b.delivery_note ?? null, b.contact ?? null, startBlock, now()).run();
  return c.json({
    order_id: id, product: p.title, qty, seller: s.name, seller_wallet: s.wallet,
    amount_atomic: amount.toString(), amount_usdc: atomicToUsd(amount.toString()), usdc_contract: USDC_BASE, chain: "eip155:8453",
  });
});

async function findPayment(env: Env, o: any, wallet: string, txHash?: string) {
  const toTopic = "0x" + wallet.slice(2).padStart(64, "0");
  const want = BigInt(o.amount_atomic);
  const match = (l: any) =>
    l.address?.toLowerCase() === USDC_BASE && l.topics?.[0] === TRANSFER_TOPIC &&
    l.topics?.[2]?.toLowerCase() === toTopic && BigInt(l.data) === want;
  if (txHash) {
    const r = await rpc(env, "eth_getTransactionReceipt", [txHash]);
    if (r && r.status === "0x1") { const l = r.logs.find(match); if (l) return l.transactionHash as string; }
    return null;
  }
  const latest = Number(BigInt(await rpc(env, "eth_blockNumber", [])));
  // Orders are recent: only scan from when the order was created (Base makes ~1 block / 2s).
  const from = Math.max(o.start_block ? o.start_block - 5 : latest - 900, latest - 3000);
  for (let start = from; start <= latest; start += 500) {
    const logs = await rpc(env, "eth_getLogs", [{
      address: USDC_BASE, topics: [TRANSFER_TOPIC, null, toTopic],
      fromBlock: "0x" + start.toString(16), toBlock: "0x" + Math.min(latest, start + 499).toString(16),
    }]);
    const l = logs.find(match);
    if (l) return l.transactionHash as string;
  }
  return null;
}

app.post("/orders/:id/confirm", async (c) => {
  const b: any = await c.req.json().catch(() => ({}));
  const o: any = await c.env.DB.prepare("SELECT o.*, p.title FROM orders o JOIN products p ON p.id = o.product_id WHERE o.id = ?").bind(c.req.param("id")).first();
  if (!o) return err(c, 404, "order not found");
  const s: any = await c.env.DB.prepare("SELECT * FROM stalls WHERE id = ?").bind(o.stall_id).first();
  if (o.status !== "paid") {
    let tx: string | null = null;
    try { tx = await findPayment(c.env, o, s.wallet, b.tx_hash); } catch (e: any) { return err(c, 502, `could not check the payment right now, please try again in a few seconds (${e.message})`); }
    if (tx) {
      const upd = await c.env.DB.prepare("UPDATE orders SET status = 'paid', tx_hash = ?, paid_at = ? WHERE id = ? AND status != 'paid'").bind(tx, now(), o.id).run();
      if (upd.meta.changes) await c.env.DB.prepare("UPDATE products SET stock = MAX(0, stock - ?) WHERE id = ?").bind(o.qty, o.product_id).run();
      o.status = "paid"; o.tx_hash = tx;
    }
  }
  const msg = `Hi ${s.name}! I just paid ${atomicToUsd(o.amount_atomic)} USDC for ${o.qty} x ${o.title} (order ${o.id}).` +
    (o.tx_hash ? ` Receipt: https://basescan.org/tx/${o.tx_hash}` : "") + (o.note ? ` Delivery: ${o.note}` : "");
  return c.json({
    order_id: o.id, status: o.status, product: o.title, amount_usdc: atomicToUsd(o.amount_atomic),
    tx_hash: o.tx_hash ?? "", receipt_url: o.tx_hash ? `https://basescan.org/tx/${o.tx_hash}` : "",
    message_seller_url: contactLink(s.whatsapp, msg),
  });
});

// ---------- price watch ----------
app.post("/watches", async (c) => {
  const b: any = await c.req.json();
  const cents = Math.round(Number(b.max_price_usd) * 100);
  if (!(cents > 0) || (!b.query && !b.product_id)) return err(c, 400, "query or product_id, and max_price_usd, are required");
  const id = `w_${rid(8)}`;
  await c.env.DB.prepare("INSERT INTO watches (id, query, product_id, max_cents, created_at) VALUES (?,?,?,?,?)")
    .bind(id, b.query ? String(b.query).toLowerCase() : null, b.product_id ?? null, cents, now()).run();
  return c.json({ watch_id: id, max_price_usd: (cents / 100).toFixed(2) });
});

app.get("/watches/:id", async (c) => {
  const w: any = await c.env.DB.prepare("SELECT * FROM watches WHERE id = ?").bind(c.req.param("id")).first();
  if (!w) return err(c, 404, "watch not found");
  let sql = "SELECT p.*, s.slug, s.name AS sname, s.city FROM products p JOIN stalls s ON s.id = p.stall_id WHERE p.stock > 0 AND p.price_cents <= ?";
  const args: unknown[] = [w.max_cents];
  if (w.product_id) { sql += " AND p.id = ?"; args.push(w.product_id); }
  else for (const word of String(w.query).split(/\s+/).filter(Boolean).slice(0, 5)) {
    sql += " AND lower(p.title || ' ' || coalesce(p.description,'') || ' ' || s.name) LIKE ?"; args.push(`%${word}%`);
  }
  sql += " ORDER BY p.price_cents ASC LIMIT 10";
  const { results } = await c.env.DB.prepare(sql).bind(...args).all();
  return c.json({
    watch_id: w.id, target: w.product_id ?? w.query, max_price_usd: (w.max_cents / 100).toFixed(2),
    triggered: results.length > 0, matches: results.map((p: any) => publicProduct(p, { slug: p.slug, name: p.sname, city: p.city })),
  });
});

// ---------- shareable stall page (for IG bio / WhatsApp status) ----------
app.get("/s/:slug", async (c) => {
  const s: any = await c.env.DB.prepare("SELECT * FROM stalls WHERE slug = ?").bind(c.req.param("slug")).first();
  if (!s) return c.text("Stall not found", 404);
  const { results } = await c.env.DB.prepare("SELECT * FROM products WHERE stall_id = ? ORDER BY created_at DESC").bind(s.id).all();
  const esc = (x: string) => String(x ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]!));
  const cards = results.map((p: any) => `
    <div class="card">${p.photo_url ? `<img src="${esc(p.photo_url)}" alt="">` : `<div class="ph">🛍️</div>`}
      <div class="b"><h3>${esc(p.title)}</h3><p>${esc(p.description ?? "")}</p>
      <div class="row"><b>${usd(p.price_cents)}</b><span>${p.stock > 0 ? `${p.stock} in stock` : "sold out"}</span></div>
      <code>${p.id}</code></div></div>`).join("");
  return c.html(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(s.name)} · Stall</title><style>
body{font-family:system-ui,sans-serif;margin:0;background:#0b0b0f;color:#f2f2f5}
header{padding:28px 20px;background:linear-gradient(135deg,#7c3aed,#db2777)}h1{margin:0 0 6px}header p{margin:0;opacity:.9}
.ask{margin:18px 20px;padding:14px 16px;border-radius:14px;background:#17171f;border:1px solid #2a2a36;font-size:14px;line-height:1.5}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px;padding:0 20px 30px}
.card{background:#17171f;border:1px solid #2a2a36;border-radius:16px;overflow:hidden}.card img,.ph{width:100%;height:170px;object-fit:cover;background:#22222c;display:flex;align-items:center;justify-content:center;font-size:44px}
.b{padding:12px 14px}h3{margin:0 0 4px;font-size:16px}.b p{margin:0 0 10px;color:#a8a8b8;font-size:13px}.row{display:flex;justify-content:space-between;align-items:center}
code{display:block;margin-top:8px;color:#8b8ba0;font-size:11px}a.wa{display:inline-block;margin-top:12px;padding:8px 14px;border-radius:999px;background:#25d366;color:#04230f;text-decoration:none;font-weight:600}
</style></head><body><header><h1>${esc(s.name)}</h1><p>${esc(s.bio ?? "")}${s.city ? ` · 📍 ${esc(s.city)}` : ""}</p>
${contactLink(s.whatsapp, `Hi ${s.name}!`) ? `<a class="wa" href="${esc(contactLink(s.whatsapp, `Hi ${s.name}!`))}">Message the seller</a>` : ""}</header>
<div class="ask">🤖 <b>Buy with your AI assistant.</b> In Claude or ChatGPT with PayBox connected, just say:<br><i>"Buy the ${esc((results[0] as any)?.title ?? "item")} from ${esc(s.name)} on Stall"</i>. Approve with one tap and you're done. You pay in digital dollars (USDC), straight to the seller.</div>
<div class="grid">${cards || "<p>No products yet.</p>"}</div></body></html>`);
});

export default app;
