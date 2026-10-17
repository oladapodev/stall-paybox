# Stall 🛍️

**Let anyone who sells things be found and paid by AI assistants.**

A PayBox plugin for the MoonPay Hackathon (Chapter 1).

People are starting to shop by asking Claude or ChatGPT. Big stores are getting ready for that. Small sellers are not: the candle maker, the ceramics studio, the market trader, the side hustle with no website. Stall gives every one of them a shop that AI assistants can search and pay, in a single chat message.

- **Sellers** open a shop by chatting: shop name, how to contact them (phone, email or link) and where to get paid. Add items in plain words. Share the shop link anywhere.
- **Buyers** say "find me a handmade mug under $20". Their assistant searches every shop, and PayBox asks for one tap to approve. The money (USDC, digital dollars on Base) goes **straight to the seller**. No middleman, nobody holds the money.
- **Price drop alerts**: "tell me when a leather wallet is under $40". When a seller lowers the price, the buyer is one tap from buying.
- After paying, the buyer gets a receipt and a ready-to-send message to the seller with the order details.

## How it works

```
Seller --chat--> AI assistant --open_shop / add_item--> Stall API
Buyer  --chat--> AI assistant --find_items / buy_item--> Stall API
buy_item --> payment proposal (USDC transfer on Base) --> PayBox one-tap approval --> seller's wallet
confirm_payment --> Stall API checks the payment on Base --> receipt + message to seller
```

Each order gets a **unique amount** (the price plus a tiny fraction of a cent, e.g. 0.500137), so a normal USDC transfer identifies the order. No custom contract, one payment, one approval.

## Tools

| Tool | Who | What it does |
|---|---|---|
| `open_shop` | seller | Open a shop, get a share link and a private shop key |
| `add_item` / `update_item` | seller | List items, change price or stock (lower prices alert waiting buyers) |
| `my_orders` | seller | Orders, paid status, delivery details, receipts |
| `find_items` / `view_shop` | buyer | Search all shops, cheapest first |
| `buy_item` | buyer | Place the order and prepare the payment to the seller |
| `confirm_payment` | buyer | Check the payment arrived, receipt, message the seller |
| `watch_price` / `check_watch` | buyer | Price drop alerts that turn into one-tap buys |

## Repo

- `plugin/` PayBox plugin (official starter 1.0.2, MCP server bundled to `dist/plugin.mjs`)
- `api/` Stall API: Hono on Cloudflare Workers + D1, checks USDC payments on Base

```bash
cd plugin && pnpm install --frozen-lockfile && pnpm test   # conformance
cd api && npx wrangler deploy                              # API
```

Network host to allow in the PayBox portal: `stall-api.oladapo.workers.dev`
