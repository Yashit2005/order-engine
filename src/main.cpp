// Mini order matching engine — HTTP/WebSocket front end over the C++17 book.
//
// Engine and I/O share one thread on purpose: the matching path stays
// single-threaded and lock-free, which is how real venues keep a book
// deterministic. Bursts are processed in chunks between poll() calls so the UI
// keeps streaming while a million orders are being drained.

#include "order_book.hpp"
#include "ws_server.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <deque>
#include <sstream>
#include <string>
#include <vector>

using namespace ome;
using Clock = std::chrono::steady_clock;

namespace {

constexpr Price TICK      = 5;       // 5 paise, NSE equity tick
constexpr Price REF_PRICE = 250000;  // Rs. 2500.00
constexpr std::size_t DEPTH_LEVELS = 14;

// xorshift64* — the order generator runs millions of times per burst, so the
// RNG must not be the bottleneck.
struct Rng {
    std::uint64_t s = 0x9E3779B97F4A7C15ull;
    std::uint64_t next() {
        s ^= s >> 12; s ^= s << 25; s ^= s >> 27;
        return s * 0x2545F4914F6CDD1Dull;
    }
    std::uint32_t below(std::uint32_t n) { return static_cast<std::uint32_t>(next() % n); }
};

Price roundTick(Price p) { return (p / TICK) * TICK; }

std::string fmtPrice(Price p) {
    char buf[32];
    std::snprintf(buf, sizeof(buf), "%.2f", static_cast<double>(p) / 100.0);
    return buf;
}

// ---------------------------------------------------------------- tiny JSON reader
// The command protocol is a handful of flat string/number fields, so a full
// parser would be dead weight.
bool jsonNum(const std::string& s, const char* key, double& out) {
    const std::string pat = std::string("\"") + key + "\"";
    std::size_t k = s.find(pat);
    if (k == std::string::npos) return false;
    k = s.find(':', k + pat.size());
    if (k == std::string::npos) return false;
    try { out = std::stod(s.substr(k + 1)); } catch (...) { return false; }
    return true;
}

bool jsonStr(const std::string& s, const char* key, std::string& out) {
    const std::string pat = std::string("\"") + key + "\"";
    std::size_t k = s.find(pat);
    if (k == std::string::npos) return false;
    k = s.find(':', k + pat.size());
    if (k == std::string::npos) return false;
    const std::size_t a = s.find('"', k);
    if (a == std::string::npos) return false;
    const std::size_t b = s.find('"', a + 1);
    if (b == std::string::npos) return false;
    out = s.substr(a + 1, b - a - 1);
    return true;
}

// ---------------------------------------------------------------- app state
struct TapeEntry {
    Price price;
    Qty   qty;
    Side  side;
};

struct MyOrder {
    OrderId id;
    Side    side;
    Price   price;
    Qty     qty;
    Qty     filled;
    bool    live;
};

class Engine {
public:
    Engine() : book_(1u << 21) { seed(); }

    void seed() {
        book_.clear();
        nextId_ = 1;
        mine_.clear();
        tape_.clear();
        mid_ = REF_PRICE;
        for (int i = 1; i <= 60; ++i) {
            const Qty q = 25 + rng_.below(400);
            book_.submit(nextId_++, Side::Buy,  OrderType::Limit, mid_ - i * TICK, q);
            book_.submit(nextId_++, Side::Sell, OrderType::Limit, mid_ + i * TICK, 25 + rng_.below(400));
        }
        book_.clearTrades();
    }

    // A trickle of background flow so the tape and depth are never static.
    void ambient(int orders) {
        for (int i = 0; i < orders; ++i) {
            const bool buy = rng_.below(2) == 0;
            const int  off = static_cast<int>(rng_.below(25)) - 8; // sometimes crosses
            const Price px = roundTick(mid_ + (buy ? -off : off) * TICK);
            const Qty   q  = 10 + rng_.below(300);
            book_.submit(nextId_++, buy ? Side::Buy : Side::Sell, OrderType::Limit, px, q);
        }
        reprice();
    }

    // Simulates a fast selloff: heavy aggressive sell flow, mid dragged down
    // `dropPct` over the life of the burst. Returns orders actually processed.
    std::uint64_t burstChunk(std::uint64_t n) {
        const std::uint64_t take = std::min(n, burstLeft_);
        const auto t0 = Clock::now();

        for (std::uint64_t i = 0; i < take; ++i) {
            const std::uint64_t done = burstTotal_ - burstLeft_ + i;
            const double  progress = static_cast<double>(done) / static_cast<double>(burstTotal_);
            const Price   ref = roundTick(static_cast<Price>(burstStart_ * (1.0 - 0.10 * progress)));

            const std::uint32_t r = rng_.below(100);
            if (r < 55) {
                // Panic sellers hitting the bid.
                const Price px = roundTick(ref - static_cast<Price>(rng_.below(20)) * TICK);
                book_.submit(nextId_++, Side::Sell, OrderType::Limit, px, 10 + rng_.below(500));
            } else if (r < 70) {
                book_.submit(nextId_++, Side::Sell, OrderType::Market, 0, 10 + rng_.below(200));
            } else if (r < 95) {
                // Bargain hunters stacking bids under the fall.
                const Price px = roundTick(ref - static_cast<Price>(2 + rng_.below(60)) * TICK);
                book_.submit(nextId_++, Side::Buy, OrderType::Limit, px, 10 + rng_.below(500));
            } else {
                const Price px = roundTick(ref + static_cast<Price>(rng_.below(15)) * TICK);
                book_.submit(nextId_++, Side::Buy, OrderType::Limit, px, 10 + rng_.below(300));
            }
        }

        burstLeft_ -= take;
        const double ns = std::chrono::duration<double, std::nano>(Clock::now() - t0).count();
        burstNs_    += ns;
        burstDone_  += take;
        if (burstLeft_ == 0 && burstDone_ > 0) {
            burstRate_ = burstDone_ / (burstNs_ / 1e9);
            lastBurstOrders_ = burstDone_;
        }
        reprice();
        return take;
    }

    void startBurst(std::uint64_t total) {
        burstTotal_ = total;
        burstLeft_  = total;
        burstDone_  = 0;
        burstNs_    = 0;
        burstStart_ = mid_;
    }

    bool bursting() const { return burstLeft_ > 0; }

    OrderId submitUser(Side side, OrderType type, Price px, Qty qty) {
        const OrderId id = nextId_++;
        const auto t0 = Clock::now();
        const ExecReport rep = book_.submit(id, side, type, px, qty);
        lastLatencyNs_ = std::chrono::duration<double, std::nano>(Clock::now() - t0).count();

        // Fills are booked from the trade stream in drainTrades(), so this
        // starts at zero — counting rep.filled here too would double it.
        mine_.push_back(MyOrder{id, side, type == OrderType::Market ? 0 : px, qty, 0,
                                rep.status == Status::Resting});
        if (mine_.size() > 40) mine_.pop_front();
        reprice();
        return id;
    }

    void cancelUser(OrderId id) {
        if (book_.cancel(id)) {
            for (auto& m : mine_) if (m.id == id) m.live = false;
        }
    }

    // Drains trades produced since the last publish into the rolling tape.
    void drainTrades() {
        for (const Trade& t : book_.trades()) {
            tape_.push_front(TapeEntry{t.price, t.qty, t.aggressorSide});
            for (auto& m : mine_) {
                if (m.id == t.aggressor || m.id == t.resting) {
                    m.filled += t.qty;
                    m.qty     = std::max<Qty>(0, m.qty - t.qty);
                    if (m.qty == 0) m.live = false;
                }
            }
        }
        while (tape_.size() > 25) tape_.pop_back();
        book_.clearTrades();
    }

    std::string snapshot(double obsRate) {
        std::vector<LevelView> bids, asks;
        book_.depth(Side::Buy,  DEPTH_LEVELS, bids);
        book_.depth(Side::Sell, DEPTH_LEVELS, asks);

        Price bb = 0, ba = 0;
        const bool hasBb = book_.bestBid(bb);
        const bool hasBa = book_.bestAsk(ba);

        Qty maxQty = 1;
        for (const auto& l : bids) maxQty = std::max(maxQty, l.qty);
        for (const auto& l : asks) maxQty = std::max(maxQty, l.qty);

        std::ostringstream o;
        o << "{\"t\":\"snap\",\"bids\":[";
        for (std::size_t i = 0; i < bids.size(); ++i) {
            if (i) o << ',';
            o << "[\"" << fmtPrice(bids[i].price) << "\"," << bids[i].qty << ',' << bids[i].orders << ']';
        }
        o << "],\"asks\":[";
        for (std::size_t i = 0; i < asks.size(); ++i) {
            if (i) o << ',';
            o << "[\"" << fmtPrice(asks[i].price) << "\"," << asks[i].qty << ',' << asks[i].orders << ']';
        }
        o << "],\"maxQty\":" << maxQty
          << ",\"bb\":\"" << (hasBb ? fmtPrice(bb) : "-") << "\""
          << ",\"ba\":\"" << (hasBa ? fmtPrice(ba) : "-") << "\""
          << ",\"spread\":\"" << ((hasBb && hasBa) ? fmtPrice(ba - bb) : "-") << "\""
          << ",\"last\":\"" << fmtPrice(book_.lastPrice() ? book_.lastPrice() : mid_) << "\""
          << ",\"ref\":\"" << fmtPrice(REF_PRICE) << "\""
          << ",\"live\":" << book_.liveOrders()
          << ",\"levels\":" << (book_.bidLevels() + book_.askLevels())
          << ",\"trades\":" << book_.tradeCount()
          << ",\"volume\":" << book_.volume()
          << ",\"rate\":" << static_cast<std::uint64_t>(obsRate)
          << ",\"burstRate\":" << static_cast<std::uint64_t>(burstRate_)
          << ",\"burstOrders\":" << lastBurstOrders_
          << ",\"burstLeft\":" << burstLeft_
          << ",\"lat\":" << static_cast<std::uint64_t>(lastLatencyNs_)
          << ",\"tape\":[";
        {
            std::size_t i = 0;
            for (const TapeEntry& e : tape_) {
                if (i++) o << ',';
                o << "{\"p\":\"" << fmtPrice(e.price) << "\",\"q\":" << e.qty
                  << ",\"s\":\"" << (e.side == Side::Buy ? "B" : "S") << "\"}";
            }
        }
        o << "],\"mine\":[";
        {
            std::size_t i = 0;
            for (auto it = mine_.rbegin(); it != mine_.rend() && i < 12; ++it, ++i) {
                if (i) o << ',';
                o << "{\"id\":" << it->id << ",\"s\":\"" << (it->side == Side::Buy ? "BUY" : "SELL")
                  << "\",\"p\":\"" << (it->price ? fmtPrice(it->price) : "MKT") << "\",\"q\":" << it->qty
                  << ",\"f\":" << it->filled << ",\"live\":" << (it->live ? 1 : 0) << '}';
            }
        }
        o << "]}";
        return o.str();
    }

    Price mid() const { return mid_; }

private:
    void reprice() {
        Price bb = 0, ba = 0;
        const bool hb = book_.bestBid(bb), ha = book_.bestAsk(ba);
        if (hb && ha)      mid_ = roundTick((bb + ba) / 2);
        else if (hb)       mid_ = bb;
        else if (ha)       mid_ = ba;
    }

    OrderBook            book_;
    Rng                  rng_;
    OrderId              nextId_ = 1;
    Price                mid_    = REF_PRICE;
    std::deque<TapeEntry> tape_;
    std::deque<MyOrder>   mine_;

    Price         burstStart_      = REF_PRICE;
    std::uint64_t burstTotal_      = 0;
    std::uint64_t burstLeft_       = 0;
    std::uint64_t burstDone_       = 0;
    std::uint64_t lastBurstOrders_ = 0;
    double        burstNs_         = 0;
    double        burstRate_       = 0;
    double        lastLatencyNs_   = 0;
};

} // namespace

int main(int argc, char** argv) {
    const std::uint16_t port = (argc > 1) ? static_cast<std::uint16_t>(std::atoi(argv[1])) : 8080;
    const std::string docroot = (argc > 2) ? argv[2] : "web";

    Engine engine;
    net::WsServer server;
    if (!server.start(port, docroot)) {
        std::fprintf(stderr, "failed to bind port %u\n", port);
        return 1;
    }

    bool autoFlow = true;
    std::uint64_t ordersThisWindow = 0;

    server.onOpen([&](int id) { server.send(id, engine.snapshot(0)); });

    server.onMessage([&](int, const std::string& msg) {
        std::string cmd;
        if (!jsonStr(msg, "cmd", cmd)) return;

        if (cmd == "new") {
            std::string sideStr = "buy", typeStr = "limit";
            double px = 0, qty = 0;
            jsonStr(msg, "side", sideStr);
            jsonStr(msg, "type", typeStr);
            jsonNum(msg, "price", px);
            jsonNum(msg, "qty", qty);
            if (qty <= 0) return;

            const Side side = (sideStr == "sell") ? Side::Sell : Side::Buy;
            const OrderType type = (typeStr == "market") ? OrderType::Market
                                 : (typeStr == "ioc")    ? OrderType::IOC
                                                         : OrderType::Limit;
            const Price price = roundTick(static_cast<Price>(std::llround(px * 100.0)));
            engine.submitUser(side, type, price, static_cast<Qty>(qty));
            ++ordersThisWindow;

        } else if (cmd == "cancel") {
            double id = 0;
            if (jsonNum(msg, "id", id)) engine.cancelUser(static_cast<OrderId>(id));

        } else if (cmd == "crash") {
            double n = 500000;
            jsonNum(msg, "orders", n);
            engine.startBurst(static_cast<std::uint64_t>(std::max(1000.0, n)));

        } else if (cmd == "flow") {
            double on = 1;
            jsonNum(msg, "on", on);
            autoFlow = on != 0;

        } else if (cmd == "reset") {
            engine.seed();
        }
    });

    std::printf("order engine listening on http://localhost:%u  (docroot: %s)\n", port, docroot.c_str());

    auto lastPub = Clock::now();
    while (true) {
        server.poll(engine.bursting() ? 0 : 10);

        if (engine.bursting()) {
            ordersThisWindow += engine.burstChunk(50000);
        } else if (autoFlow) {
            const int n = 40;
            engine.ambient(n);
            ordersThisWindow += static_cast<std::uint64_t>(n);
        }

        const auto now = Clock::now();
        const double elapsed = std::chrono::duration<double>(now - lastPub).count();
        if (elapsed >= 0.1) {
            engine.drainTrades();
            server.broadcast(engine.snapshot(ordersThisWindow / elapsed));
            ordersThisWindow = 0;
            lastPub = now;
        }
    }
}
