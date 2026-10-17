import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { evmOutputSchema, proposeEvm } from "./paybox.js";

const PROTOCOL_VERSION = "2026-07-28";
const API = "https://stall-api.oladapo.workers.dev";
const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const PROPOSAL_KEY = "io.paybox/transactionProposal";

// ---------- HTTP ----------
async function api<T = any>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: init?.method ?? (init?.body ? "POST" : "GET"),
    headers: { "content-type": "application/json" },
    body: init?.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(6000),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `Stall API returned ${res.status}`);
  return json as T;
}

// ---------- shapes ----------
const evmAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x EVM address");
const stallRef = z.string().min(1).max(64).describe("The shop's short name from its link, e.g. 'adas-fabrics'");
const editKey = z.string().min(4).max(64).describe("The seller's private shop key (given when the shop was opened)");
const money = z.number().positive().max(100000);

const stallInfo = z.object({ slug: z.string(), name: z.string(), city: z.string() }).strict();
const product = z.object({
  product_id: z.string(),
  title: z.string(),
  description: z.string(),
  price_usd: z.string(),
  stock: z.number(),
  photo_url: z.string(),
  stall: stallInfo.optional(),
}).strict();
type Product = z.infer<typeof product>;

const toProduct = (p: any): Product => ({
  product_id: String(p.product_id),
  title: String(p.title),
  description: String(p.description ?? ""),
  price_usd: String(p.price_usd),
  stock: Number(p.stock),
  photo_url: String(p.photo_url ?? ""),
  ...(p.stall ? { stall: { slug: String(p.stall.slug), name: String(p.stall.name), city: String(p.stall.city ?? "") } } : {}),
});
const line = (p: Product) =>
  `• ${p.title} - $${p.price_usd}${p.stall ? ` from ${p.stall.name}${p.stall.city ? ` (${p.stall.city})` : ""}` : ""} [${p.product_id}]${p.stock > 0 ? "" : " SOLD OUT"}`;

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
const writes = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;

// ERC-20 transfer(address,uint256) calldata, no extra dependency needed.
function erc20Transfer(to: string, amountAtomic: string) {
  const addr = to.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  const amt = BigInt(amountAtomic).toString(16).padStart(64, "0");
  return `0xa9059cbb${addr}${amt}`;
}

function createServer() {
  const server = new McpServer(
    { name: "stall", version: "0.1.0" },
    { supportedProtocolVersions: [PROTOCOL_VERSION] },
  );

  // ===================== SELLER =====================
  server.registerTool("open_shop", {
    title: "Open a shop (for sellers)",
    description:
      "For anyone who sells things (a small business, side hustle, creator, market stall or online seller) and wants AI assistants to be able to find and buy from them. No website needed. Returns a shop link to share anywhere and a private shop key the seller keeps to add items and see orders. Buyers pay in USDC (digital dollars) straight to payout_wallet.",
    inputSchema: z.object({
      name: z.string().min(2).max(60).describe("Shop name, e.g. 'Ada's Fabrics' or 'Green Leaf Candles'"),
      contact: z.string().min(3).max(120).describe("How buyers reach the seller: phone number with country code, email, or a link"),
      payout_wallet: evmAddress.describe("Seller's Base wallet address that receives payments"),
      city: z.string().max(40).optional().describe("City or area, helps local buyers find the shop"),
      bio: z.string().max(200).optional().describe("One line about the shop"),
    }).strict(),
    outputSchema: z.object({ slug: z.string(), edit_key: z.string(), share_url: z.string() }).strict(),
    annotations: writes,
  }, async ({ name, contact, payout_wallet, city, bio }) => {
    const r = await api("/stalls", { body: { name, contact, wallet: payout_wallet, city, bio } });
    const out = { slug: String(r.slug), edit_key: String(r.edit_key), share_url: String(r.share_url) };
    return {
      content: [{ type: "text", text: `Your shop "${name}" is open: ${out.share_url}\nShare this link anywhere you sell.\nShop name for buyers: ${out.slug}\nPrivate shop key (keep it safe, you need it to add items and see orders): ${out.edit_key}\nNext: add your first item.` }],
      structuredContent: out,
    };
  });

  server.registerTool("add_item", {
    title: "Add an item to sell (for sellers)",
    description: "List something for sale with a price in US dollars and how many are available. Buyers' AI assistants can find and buy it right away.",
    inputSchema: z.object({
      stall: stallRef, edit_key: editKey,
      title: z.string().min(2).max(80),
      price_usd: money.describe("Price in US dollars"),
      stock: z.number().int().min(0).max(100000).optional().describe("Units available, default 1"),
      description: z.string().max(300).optional(),
      photo_url: z.url().max(500).optional(),
    }).strict(),
    outputSchema: z.object({ product }).strict(),
    annotations: writes,
  }, async ({ stall, edit_key, ...rest }) => {
    const r = await api(`/stalls/${encodeURIComponent(stall)}/products`, { body: { edit_key, ...rest } });
    const p = toProduct(r.product);
    return { content: [{ type: "text", text: `Added:\n${line(p)}` }], structuredContent: { product: p } };
  });

  server.registerTool("update_item", {
    title: "Change price or stock (for sellers)",
    description: "Change an item's price, how many are left, or its name. Lowering a price alerts buyers who are waiting for a cheaper price.",
    inputSchema: z.object({
      stall: stallRef, edit_key: editKey,
      product_id: z.string().min(3).max(32),
      price_usd: money.optional(),
      stock: z.number().int().min(0).max(100000).optional(),
      title: z.string().min(2).max(80).optional(),
    }).strict(),
    outputSchema: z.object({ product, watchers_now_matching: z.number() }).strict(),
    annotations: writes,
  }, async ({ stall, edit_key, product_id, ...rest }) => {
    const r = await api(`/stalls/${encodeURIComponent(stall)}/products/${encodeURIComponent(product_id)}`, { method: "PATCH", body: { edit_key, ...rest } });
    const p = toProduct(r.product);
    const n = Number(r.watchers_now_matching ?? 0);
    return {
      content: [{ type: "text", text: `Updated:\n${line(p)}${n ? `\n${n} buyer(s) waiting for this price will now see it.` : ""}` }],
      structuredContent: { product: p, watchers_now_matching: n },
    };
  });

  server.registerTool("my_orders", {
    title: "See my orders (for sellers)",
    description: "See the latest orders: what was bought, whether it's paid, delivery details and the payment receipt.",
    inputSchema: z.object({ stall: stallRef, edit_key: editKey }).strict(),
    outputSchema: z.object({
      orders: z.array(z.object({
        order_id: z.string(), product: z.string(), qty: z.number(), amount_usdc: z.string(),
        status: z.string(), delivery_note: z.string(), buyer_contact: z.string(), tx_hash: z.string(),
      }).strict()),
    }).strict(),
    annotations: readOnly,
  }, async ({ stall, edit_key }) => {
    const r = await api(`/stalls/${encodeURIComponent(stall)}/orders`, { body: { edit_key } });
    const orders = (r.orders ?? []).map((o: any) => ({
      order_id: String(o.order_id), product: String(o.product), qty: Number(o.qty), amount_usdc: String(o.amount_usdc),
      status: String(o.status), delivery_note: String(o.delivery_note ?? ""), buyer_contact: String(o.buyer_contact ?? ""), tx_hash: String(o.tx_hash ?? ""),
    }));
    const text = orders.length
      ? orders.map((o: any) => `• ${o.qty} x ${o.product} - $${o.amount_usdc} - ${o.status === "paid" ? "PAID" : "waiting for payment"}${o.delivery_note ? ` - deliver to: ${o.delivery_note}` : ""} (order ${o.order_id})`).join("\n")
      : "No orders yet.";
    return { content: [{ type: "text", text }], structuredContent: { orders } };
  });

  // ===================== BUYER =====================
  server.registerTool("find_items", {
    title: "Find things to buy from independent sellers",
    description:
      "Search items sold by independent shops and small businesses (clothing, food, crafts, beauty, gadgets, art, services and more). Use when the user wants to buy something from a small or local seller. Cheapest first.",
    inputSchema: z.object({
      query: z.string().min(1).max(80).describe("What the user wants, e.g. 'scented candle' or 'handmade bag'"),
      max_price_usd: money.optional(),
      city: z.string().max(40).optional(),
    }).strict(),
    outputSchema: z.object({ results: z.array(product) }).strict(),
    annotations: readOnly,
  }, async ({ query, max_price_usd, city }) => {
    const qs = new URLSearchParams({ q: query });
    if (max_price_usd) qs.set("max_usd", String(max_price_usd));
    if (city) qs.set("city", city);
    const r = await api(`/search?${qs}`);
    const results = (r.results ?? []).map(toProduct);
    return {
      content: [{ type: "text", text: results.length ? results.map(line).join("\n") : `Nothing found for "${query}" yet. Try different words, or ask me to tell you when it shows up under your price.` }],
      structuredContent: { results },
    };
  });

  server.registerTool("view_shop", {
    title: "Look inside a shop",
    description: "Show a shop, everything it sells, and a link to message the seller.",
    inputSchema: z.object({ stall: stallRef }).strict(),
    outputSchema: z.object({
      stall: z.object({ slug: z.string(), name: z.string(), city: z.string(), bio: z.string(), contact_link: z.string() }).strict(),
      products: z.array(product),
    }).strict(),
    annotations: readOnly,
  }, async ({ stall }) => {
    const r = await api(`/stalls/${encodeURIComponent(stall)}`);
    const s = { slug: String(r.stall.slug), name: String(r.stall.name), city: String(r.stall.city ?? ""), bio: String(r.stall.bio ?? ""), contact_link: String(r.stall.contact_link ?? "") };
    const products = (r.products ?? []).map(toProduct);
    return {
      content: [{ type: "text", text: `${s.name}${s.city ? ` (${s.city})` : ""}${s.bio ? ` - ${s.bio}` : ""}\n${products.map(line).join("\n") || "Nothing for sale yet."}${s.contact_link ? `\nMessage the seller: ${s.contact_link}` : ""}` }],
      structuredContent: { stall: s, products },
    };
  });

  const order = z.object({
    order_id: z.string(), product: z.string(), qty: z.number(), seller: z.string(),
    seller_wallet: z.string(), amount_usdc: z.string(),
  }).strict();

  server.registerTool("buy_item", {
    title: "Buy an item",
    description:
      "Place an order and prepare the payment straight to the seller, in USDC (digital dollars) on Base. PayBox shows the user the payment to approve with one tap. Once approved, call confirm_payment with the order_id to get the receipt and a link to message the seller.",
    inputSchema: z.object({
      product_id: z.string().min(3).max(32),
      qty: z.number().int().min(1).max(100).optional(),
      delivery_note: z.string().max(300).optional().describe("Where to deliver, or a pickup note for the seller"),
      contact: z.string().max(60).optional().describe("Buyer's phone or email so the seller can reach them"),
    }).strict(),
    outputSchema: evmOutputSchema.extend({ order }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ product_id, qty, delivery_note, contact }) => {
    const r = await api("/orders", { body: { product_id, qty: qty ?? 1, delivery_note, contact } });
    const proposal = proposeEvm({ chain: "eip155:8453", to: USDC_BASE, value: "0", data: erc20Transfer(r.seller_wallet, r.amount_atomic) });
    const o = {
      order_id: String(r.order_id), product: String(r.product), qty: Number(r.qty), seller: String(r.seller),
      seller_wallet: String(r.seller_wallet), amount_usdc: String(r.amount_usdc),
    };
    return {
      content: [{
        type: "text",
        text: `Order placed: ${o.qty} x ${o.product} from ${o.seller}. Total: $${o.amount_usdc}, paid straight to the seller (the tiny extra fraction of a cent identifies your order). Approve the payment in PayBox, then I'll confirm it with order "${o.order_id}".`,
      }],
      structuredContent: { order: o, [PROPOSAL_KEY]: proposal.structuredContent[PROPOSAL_KEY] },
    };
  });

  server.registerTool("confirm_payment", {
    title: "Confirm payment and tell the seller",
    description: "Check that the payment arrived, mark the order paid, and return the receipt plus a ready-to-send message to the seller with the order details. Pass tx_hash if PayBox returned one for an instant check.",
    inputSchema: z.object({
      order_id: z.string().min(3).max(32),
      tx_hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
    }).strict(),
    outputSchema: z.object({
      order_id: z.string(), status: z.string(), product: z.string(), amount_usdc: z.string(),
      tx_hash: z.string(), receipt_url: z.string(), message_seller_url: z.string(),
    }).strict(),
    annotations: readOnly,
  }, async ({ order_id, tx_hash }) => {
    const r = await api(`/orders/${encodeURIComponent(order_id)}/confirm`, { body: tx_hash ? { tx_hash } : {} });
    const out = {
      order_id: String(r.order_id), status: String(r.status), product: String(r.product), amount_usdc: String(r.amount_usdc),
      tx_hash: String(r.tx_hash ?? ""), receipt_url: String(r.receipt_url ?? ""), message_seller_url: String(r.message_seller_url),
    };
    const text = out.status === "paid"
      ? `Paid ✅ $${out.amount_usdc} for ${out.product}. Receipt: ${out.receipt_url}${out.message_seller_url ? `\nSend the seller your order details: ${out.message_seller_url}` : ""}`
      : `The payment for order ${out.order_id} hasn't arrived yet. If PayBox says it went through, wait a few seconds and check again.`;
    return { content: [{ type: "text", text }], structuredContent: out };
  });

  // ===================== PRICE WATCH =====================
  server.registerTool("watch_price", {
    title: "Tell me when the price drops",
    description: "Wait for something (e.g. 'leather wallet') or a specific item to be at or below a price. Check later with check_watch, then buy with buy_item.",
    inputSchema: z.object({
      query: z.string().min(1).max(80).optional(),
      product_id: z.string().min(3).max(32).optional(),
      max_price_usd: money,
    }).strict(),
    outputSchema: z.object({ watch_id: z.string(), max_price_usd: z.string() }).strict(),
    annotations: writes,
  }, async ({ query, product_id, max_price_usd }) => {
    if (!query && !product_id) throw new Error("Tell me what to watch: a search word or an item id.");
    const r = await api("/watches", { body: { query, product_id, max_price_usd } });
    const out = { watch_id: String(r.watch_id), max_price_usd: String(r.max_price_usd) };
    return { content: [{ type: "text", text: `Got it. I'll look out for ${product_id ?? `"${query}"`} at $${out.max_price_usd} or less. (watch id: ${out.watch_id})` }], structuredContent: out };
  });

  server.registerTool("check_watch", {
    title: "Check if the price dropped",
    description: "See whether anything now matches a price watch, cheapest first.",
    inputSchema: z.object({ watch_id: z.string().min(3).max(32) }).strict(),
    outputSchema: z.object({ watch_id: z.string(), target: z.string(), max_price_usd: z.string(), triggered: z.boolean(), matches: z.array(product) }).strict(),
    annotations: readOnly,
  }, async ({ watch_id }) => {
    const r = await api(`/watches/${encodeURIComponent(watch_id)}`);
    const out = {
      watch_id: String(r.watch_id), target: String(r.target), max_price_usd: String(r.max_price_usd),
      triggered: Boolean(r.triggered), matches: (r.matches ?? []).map(toProduct),
    };
    return {
      content: [{ type: "text", text: out.triggered ? `🔔 Good news, the price dropped for ${out.target} ($${out.max_price_usd} or less):\n${out.matches.map(line).join("\n")}\nWant me to buy one?` : `Not yet. Nothing for ${out.target} at $${out.max_price_usd} or less right now.` }],
      structuredContent: out,
    };
  });

  return server;
}

serveStdio(createServer, { legacy: "reject" });
