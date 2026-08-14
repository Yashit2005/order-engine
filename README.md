# ⚡ Mini Order Matching Engine

**[🚀 Live Demo](https://yashit2005.github.io/order-engine/)**

A price-time priority limit order book in **C++17**, with a live browser terminal — place orders, watch the book match in real time, then fire a simulated market crash and watch it drain a million orders.

Target was 100k orders/sec. Measured **5.0M orders/sec** steady state and **12.4M orders/sec** under crash flow, single threaded.

## Tech Stack
- **Engine**: C++17, no dependencies
- **Server**: raw Winsock/POSIX sockets — hand-rolled HTTP + WebSocket (RFC 6455), including the SHA-1/base64 handshake
- **Frontend**: vanilla JS + CSS, no build step
- **Core DSA**: ordered map of price levels + intrusive doubly linked lists + hash index + slab allocator

## The data structure

A matching engine has to answer three questions fast, and they pull in different directions:

| Operation | Needs | Structure | Cost |
|-----------|-------|-----------|------|
| Best bid / best ask | ordered by price | `std::map` (red-black tree) | **O(1)** at `begin()` |
| Who trades first at a price | ordered by arrival | intrusive doubly linked list | **O(1)** push-back / pop-front |
| Cancel order #12345 | find it without scanning | `unordered_map<id, index>` | **O(1)** |
| Allocate/free an order | no `new` on the hot path | slab `vector<Order>` + freelist | **O(1)** |

```
bids: map<Price, Level, greater>        asks: map<Price, Level, less>
        2499.70 ──► [o1] ⇄ [o2] ⇄ [o3]          2499.80 ──► [o7] ⇄ [o8]
        2499.65 ──► [o4]                        2499.85 ──► [o9]
        2499.60 ──► [o5] ⇄ [o6]                 2499.90 ──► [o10] ⇄ [o11]
                     ▲                                       ▲
                     └── time priority: head fills first ────┘
```

Matching walks the opposite side from `begin()` outwards, filling FIFO within each level, and erases levels as they empty. An incoming order is `O(log P + F)` — `P` price levels touched, `F` orders filled — and the common case is one level deep.

Two details that matter more than the asymptotics:

- **Links are array indices, not pointers.** The slab can grow without invalidating the entire book.
- **Cancelled orders are recycled, not freed.** Real books cancel most of what they receive; a freelist keeps that path allocation-free.

## Measured performance

`./bench` — engine only, no sockets or JSON in the loop, single thread:

```
scenario 1 — steady state (passive quoting + 20% aggressive + 12% cancels)
  throughput      : 5,045,616 orders/sec
  latency p50     : 100 ns      p99: 1,100 ns      p99.9: 3,600 ns
  trades executed : 410,308

scenario 2 — crash burst (one-way panic flow, price -10%)
  throughput      : 12,370,695 orders/sec
  latency p50     : 100 ns      p99: 300 ns        p99.9: 900 ns
  trades executed : 1,366,902
```

Honest caveats, because these numbers are easy to overclaim:

- Single machine, single thread, warm cache, no network, no persistence, no risk checks. A real venue spends most of its budget on the things this does not do — margin checks, sequencing, replication, market data fan-out.
- `p50 = 100 ns` is the floor of `steady_clock` on Windows, not a true median. The p99/p99.9 figures are meaningful; the p50 is "below timer resolution".
- The crash scenario is *faster* than steady state, which looks backwards until you see why: aggressive orders match and leave, so the book stays small and cache-resident, while passive quoting grows it to a million resting orders and starts missing cache.

## The crash simulation

The UI button fires a one-way panic burst: 55% aggressive sellers hitting the bid, 15% market sells, 30% bargain-hunting bids stacked underneath, with the reference price dragged down 10% over the life of the burst. A million orders drains in well under a second and the ladder visibly collapses.

The burst is processed in 50k-order chunks between socket polls, so the UI keeps streaming while it runs.

## About the hosted demo

GitHub Pages serves static files, so it cannot run a native binary. The demo in `docs/` is the order book **ported to JavaScript** — same matching rules, same UI — running entirely client-side.

The port makes one deliberate change. The C++ engine keeps price levels in a `std::map` so it can quote any price; the browser runs inside a known price band, so the port takes the alternative described under *Design decisions*: **price levels in a flat array indexed by tick**. That removes every tree walk, every sorted-array insert and every hash of a price, and the level lookup becomes pointer arithmetic.

The consequence is that **the two numbers are not a language comparison.** The demo's crash burst runs the identical workload to `crash()` in `bench.cpp` — same three-way order split, same 10% price walk, same pre-seeded depth — but against a different level structure, so on a fast machine the browser can print a number at or above the native one. That is the data structure talking, not JavaScript beating C++.

Read it as: the flat-array variant is substantially faster than the ordered map, at the cost of assuming a bounded price band. The honest way to compare the two languages would be to give both the same structure.

The demo's number is measured live in your browser over engine time only, and labelled as such. Everything under *Measured* above comes from `bench.cpp`.

To run the actual C++ engine, build it and open `web/` — see below.

## Project structure

```
order-engine/
├── include/
│   └── order_book.hpp   # the data structure
├── src/
│   ├── order_book.cpp   # matching, cancel, depth
│   ├── ws_server.hpp    # HTTP + WebSocket, SHA-1, base64 — no deps
│   └── main.cpp         # market simulator + JSON feed
├── bench/
│   └── bench.cpp        # the numbers above
├── web/
│   ├── index.html       # trading terminal UI (talks to the C++ server)
│   ├── app.js
│   └── style.css
├── docs/                # the hosted demo — same UI, engine ported to JS
│   ├── engine.js        # the order book, structure for structure
│   └── demo.js          # market simulator, the browser's src/main.cpp
└── Makefile
```

## Running it

```bash
make
```

```bash
./engine 8080 web
```

Open <http://localhost:8080>. Place orders, click a price level to load it into the ticket, cancel from *My orders*, or hit **TRIGGER CRASH**.

```bash
./bench 2000000
```

> **Windows note:** the Makefile links the runtime statically (`-static`). Without it, a MinGW binary can load a *different* toolchain's `libstdc++-6.dll` from `PATH` and crash in unrelated places — which cost an afternoon to track down.

## Design decisions

**Why single threaded?** A book must be deterministic: the same order sequence must always produce the same trades. Sharding by symbol is how real venues scale — many independent single-threaded books, not one book with locks. Locking a shared book would cost more than it buys.

**Why `std::map` and not a flat array indexed by tick?** An array of price levels would be faster still (no tree walk, better locality), but only over a bounded price range. The map handles any price without a circuit-breaker assumption. This is the honest trade: ~50-100 ns per level lookup for generality.

**Why integer paise?** Binary floating point cannot represent 0.05 exactly, and a matching engine that fails an equality test on price is broken. Prices are `int64` ticks throughout; formatting happens at the UI boundary only.
