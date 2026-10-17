// End-to-end driver: spawns the exact dist/plugin.mjs uploaded to PayBox and calls every tool
// over stdio MCP, the same way the hosted runtime does. Asserts on observable outputs.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const PV = "2026-07-28";
let ok = 0, bad = 0;
const check = (name, cond, detail = "") => { cond ? ok++ : bad++; console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? "  " + detail : ""}`); };

function session() {
  const p = spawn("node", ["dist/plugin.mjs"], { stdio: ["pipe", "pipe", "inherit"] });
  const rl = createInterface({ input: p.stdout });
  const waiting = new Map(); let id = 0;
  rl.on("line", (l) => { try { const m = JSON.parse(l); if (waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } } catch {} });
  const req = (method, params) => new Promise((res) => { const i = ++id; waiting.set(i, res);
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method, params: { ...params, _meta: { "io.modelcontextprotocol/protocolVersion": PV, "io.modelcontextprotocol/clientInfo": { name: "stall-e2e", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} } } }) + "\n"); });
  return { req, close: () => p.kill() };
}

const s = session();
const call = async (name, args) => {
  const r = await s.req("tools/call", { name, arguments: args });
  if (r.error) return { error: r.error.message };
  return { isError: r.result.isError, text: r.result.content?.[0]?.text ?? "", data: r.result.structuredContent };
};

const W = "0x16aeaa1d36412d9ddad3602a18b41db2e14e339f";
const list = await s.req("tools/list", {});
if (list.error) { console.log("tools/list error:", JSON.stringify(list.error)); process.exit(2); }
const names = list.result.tools.map((t) => t.name).sort();
check("R1 10 plain-named tools listed", names.join(",") === "add_item,buy_item,check_watch,confirm_payment,find_items,my_orders,open_shop,update_item,view_shop,watch_price", names.join(","));
const allText = JSON.stringify(list.result.tools);
check("R2 no WhatsApp/Instagram/Nigeria wording in tool metadata", !/whatsapp|instagram|nigeria|ankara/i.test(allText));

// Seller flow (email contact)
const shop = await call("open_shop", { name: "E2E Candle Co", contact: "orders@e2ecandles.test", payout_wallet: W, city: "Toronto" });
check("R3 open_shop works with an email contact", !shop.isError && shop.data?.edit_key?.startsWith("sk_"), shop.text.split("\n")[0]);
const { slug, edit_key } = shop.data ?? {};
const item = await call("add_item", { stall: slug, edit_key, title: "Beeswax taper candles", price_usd: 0.55, stock: 3 });
check("R4 add_item lists an item", !item.isError && item.data?.product?.price_usd === "0.55", item.text.replace(/\n/g, " "));
const pid = item.data?.product?.product_id;
const badKey = await call("add_item", { stall: slug, edit_key: "sk_wrongkey", title: "x item", price_usd: 1 });
check("E1 wrong shop key is rejected", badKey.isError === true || !!badKey.error, badKey.text || badKey.error);

// Buyer flow
const found = await call("find_items", { query: "beeswax", max_price_usd: 1 });
check("R5 find_items finds the new item", found.data?.results?.some((r) => r.product_id === pid), found.text.replace(/\n/g, " "));
const none = await call("find_items", { query: "unobtainium spaceship" });
check("E2 empty search gives a friendly message", none.data?.results?.length === 0 && /Nothing found/.test(none.text), none.text);
const view = await call("view_shop", { stall: slug });
check("R6 view_shop shows email contact link", view.data?.stall?.contact_link?.startsWith("mailto:"), view.data?.stall?.contact_link);

// Price watch
const watch = await call("watch_price", { query: "beeswax", max_price_usd: 0.5 });
const wid = watch.data?.watch_id;
const before = await call("check_watch", { watch_id: wid });
check("R7 watch not triggered above target", before.data?.triggered === false, before.text);
const drop = await call("update_item", { stall: slug, edit_key, product_id: pid, price_usd: 0.45 });
check("R8 price drop reports waiting buyers", drop.data?.watchers_now_matching >= 1, drop.text.replace(/\n/g, " "));
const after = await call("check_watch", { watch_id: wid });
check("R9 watch triggers after price drop", after.data?.triggered === true, after.text.split("\n")[0]);

// Buy: proposal correctness
const buy = await call("buy_item", { product_id: pid, qty: 1, delivery_note: "Front desk" });
const prop = buy.data?.["io.paybox/transactionProposal"];
const amt = prop ? BigInt("0x" + prop.transaction.data.slice(74)) : 0n;
const to = prop ? "0x" + prop.transaction.data.slice(34, 74) : "";
check("R10 buy_item returns a Base USDC transfer proposal", prop?.kind === "evm" && prop?.chain === "eip155:8453" && prop.transaction.to.toLowerCase() === "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" && prop.transaction.data.startsWith("0xa9059cbb"));
check("R11 payment goes to the seller wallet", to.toLowerCase() === W.slice(2).padStart(40, "0").replace(/^/, "") || to.toLowerCase() === W.toLowerCase(), to);
check("R12 amount = price + sub-cent order tag", amt > 450000n && amt < 460000n, `${amt} atomic = $${Number(amt) / 1e6}`);
const tooMany = await call("buy_item", { product_id: pid, qty: 50 });
check("E3 buying more than stock is refused", tooMany.isError === true || !!tooMany.error, tooMany.text || tooMany.error);

// Confirm before payment
const conf = await call("confirm_payment", { order_id: buy.data?.order?.order_id });
check("R13 confirm_payment before paying says not arrived yet (no false 'paid')", conf.data?.status === "awaiting_payment" || /hasn't arrived|try again/.test(conf.text), conf.text || conf.error);

// Seller sees the order
const orders = await call("my_orders", { stall: slug, edit_key });
check("R14 my_orders shows the order as waiting for payment", /waiting for payment/.test(orders.text), orders.text.replace(/\n/g, " "));

s.close();
console.log(`\n${ok} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
