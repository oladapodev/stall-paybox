# Stall 🛍️

**Make every WhatsApp and Instagram seller shoppable by AI agents.**

A PayBox plugin for the MoonPay Hackathon (Chapter 1).

Shopify made 2M Shopify stores agent-ready. The millions of informal sellers who run their business on WhatsApp and Instagram (the fabric seller in Lagos, the sneaker plug, the home baker) have no website and are invisible to AI shoppers. Stall fixes that.

- **Sellers** open a stall by chatting with their agent: name, WhatsApp number, payout wallet. Add products in plain language. Get a share link for their bio.
- **Buyers** tell Claude or ChatGPT "find me Ankara fabric under $20". Their agent searches stalls, picks one, and PayBox asks for one passkey tap. USDC goes **straight to the seller's wallet on Base**. No middleman, no custody.
- **Price watch**: "tell me when anything matching 'sneakers' drops under $40". When the seller cuts the price, the watch triggers and the buy is one tap away.
- After paying, the buyer gets a Basescan receipt and a pre-filled **WhatsApp message** to the seller with order details and delivery note.

## How it works

```
Seller (WhatsApp/IG) --chat--> agent --create_stall/add_product--> Stall API
Buyer  (Claude/ChatGPT) --search_stalls/buy_product--> Stall API
buy_product --> io.paybox/transactionProposal (USDC transfer on Base) --> PayBox passkey approval --> seller wallet
confirm_order --> Stall API verifies the USDC Transfer log on Base --> receipt + wa.me link to seller
```

Each order gets a **unique amount** (price plus a sub-cent tag, e.g. 14.003949 USDC), so a plain ERC-20 transfer identifies the order on-chain. No custom contract, one transaction, one approval.

## Tools

| Tool | Who | What |
|---|---|---|
| `create_stall` | seller | Open a stall, get share link + private edit key |
| `add_product` / `update_product` | seller | List items, change price or stock (price drops hit watches) |
| `stall_orders` | seller | Orders with paid status, delivery notes, tx hashes |
| `search_stalls` / `view_stall` | buyer | Find products across stalls, cheapest first |
| `buy_product` | buyer | Create order + propose USDC payment on Base to the seller |
| `confirm_order` | buyer | Verify on-chain, receipt, WhatsApp message to seller |
| `watch_price` / `check_watch` | buyer | Price-drop alerts that turn into one-tap buys |

## Repo

- `plugin/` PayBox plugin (official starter 1.0.2, MCP server bundled to `dist/plugin.mjs`)
- `api/` Stall API: Hono on Cloudflare Workers + D1. Verifies USDC payments via Base RPC.

```bash
cd plugin && pnpm install --frozen-lockfile && pnpm test   # conformance
cd api && npx wrangler deploy                              # API
```

Hosted network host to allow in the PayBox portal: `stall-api.oladapo.workers.dev`
