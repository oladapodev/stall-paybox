# Stall demo script (60-90s)

Demo shops (all live, all pay the same demo wallet):
- Green Leaf Candles, Austin: https://stall-api.oladapo.workers.dev/s/green-leaf-candles
- Studio Mira Ceramics, Lisbon: https://stall-api.oladapo.workers.dev/s/studio-mira-ceramics
- Kai's Leather Goods, Singapore: https://stall-api.oladapo.workers.dev/s/kai-s-leather-goods
- Ada's Fabrics, Lagos: https://stall-api.oladapo.workers.dev/s/ada-s-fabrics

1. **Hook (5s):** "People are starting to shop by asking their AI. Small sellers can't be found that way. Until now."
2. **Seller (15s):** In Claude: "Open a shop called Rosa's Bakery, contact rosa@example.com, pay me at my Base wallet. Add sourdough loaf $0.80, 10 available."
3. **Buyer search (10s):** "Find a handmade mug under $1."
4. **Buy (20s):** "Buy the ceramic mug, deliver to 12 Rua Augusta." PayBox approval appears, one tap.
5. **Confirm (15s):** "Did my payment go through?" Show Paid, receipt link, and the ready-made message to the seller.
6. **Price drop (15s):** "Tell me when a leather wallet is under $1." Seller: "Lower the slim leather wallet to $0.95." Buyer: "Did the price drop?" Yes, one tap to buy.
7. **Close (5s):** "Stall. Any seller, anywhere, shoppable by AI. Built on @PayBox."

# X post

People are starting to shop by asking their AI. But the candle maker, the ceramics studio and the side hustle with no website can't be found that way.

So I built Stall for the @PayBox hackathon by @moonpay 🛍️

• Anyone can open a shop just by chatting
• Buyers ask Claude "find a handmade mug under $20"
• One tap to pay, money goes straight to the seller
• Instant receipt + order message to the seller
• Price drop alerts that turn into one-tap buys

No middleman. No website needed.

Code: https://github.com/oladapodev/stall-paybox
