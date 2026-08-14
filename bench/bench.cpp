// Measures the matching engine in isolation — no sockets, no JSON, no UI.
// Whatever this prints is what the book actually does on this machine.

#include "order_book.hpp"

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <vector>

using namespace ome;
using Clock = std::chrono::steady_clock;

namespace {

struct Rng {
    std::uint64_t s = 0x243F6A8885A308D3ull;
    std::uint64_t next() {
        s ^= s >> 12; s ^= s << 25; s ^= s >> 27;
        return s * 0x2545F4914F6CDD1Dull;
    }
    std::uint32_t below(std::uint32_t n) { return static_cast<std::uint32_t>(next() % n); }
};

constexpr Price TICK = 5;
constexpr Price REF  = 250000;

double pct(std::vector<double>& v, double p) {
    if (v.empty()) return 0;
    const std::size_t k = static_cast<std::size_t>(p * (v.size() - 1));
    std::nth_element(v.begin(), v.begin() + k, v.end());
    return v[k];
}

struct Result {
    std::uint64_t ops;
    double        seconds;
    double        p50, p99, p999;
    std::uint64_t trades;
    std::size_t   resting;
};

void report(const char* name, const Result& r) {
    std::printf("\n%s\n", name);
    std::printf("  orders          : %llu\n", static_cast<unsigned long long>(r.ops));
    std::printf("  wall time       : %.3f s\n", r.seconds);
    std::printf("  throughput      : %.0f orders/sec\n", r.ops / r.seconds);
    std::printf("  latency p50     : %.0f ns\n", r.p50);
    std::printf("  latency p99     : %.0f ns\n", r.p99);
    std::printf("  latency p99.9   : %.0f ns\n", r.p999);
    std::printf("  trades executed : %llu\n", static_cast<unsigned long long>(r.trades));
    std::printf("  resting orders  : %zu\n", r.resting);
}

// Steady-state exchange flow: mostly passive quoting, a slice of aggressive
// orders that cross, plus cancels — the mix a real book actually sees.
Result steadyState(std::uint64_t n) {
    OrderBook book(n + (1u << 20));
    Rng rng;
    std::vector<double> samples;
    samples.reserve(n / 32 + 1);
    std::vector<OrderId> live;
    live.reserve(n);

    OrderId id = 1;
    for (int i = 1; i <= 200; ++i) {
        book.submit(id++, Side::Buy,  OrderType::Limit, REF - i * TICK, 100);
        book.submit(id++, Side::Sell, OrderType::Limit, REF + i * TICK, 100);
    }
    book.clearTrades();

    const auto start = Clock::now();
    for (std::uint64_t i = 0; i < n; ++i) {
        const bool sample = (i & 31) == 0;
        const auto t0 = sample ? Clock::now() : Clock::time_point{};

        const std::uint32_t r = rng.below(100);
        if (r < 12 && !live.empty()) {
            const std::size_t k = rng.below(static_cast<std::uint32_t>(live.size()));
            book.cancel(live[k]);
            live[k] = live.back();
            live.pop_back();
        } else {
            const bool buy = rng.below(2) == 0;
            const bool aggressive = rng.below(100) < 20;
            const int  off = aggressive ? -static_cast<int>(rng.below(6))
                                        : static_cast<int>(1 + rng.below(120));
            const Price px = buy ? REF - off * TICK : REF + off * TICK;
            const Qty   q  = 10 + rng.below(400);
            const ExecReport rep = book.submit(id, buy ? Side::Buy : Side::Sell, OrderType::Limit, px, q);
            if (rep.status == Status::Resting) live.push_back(id);
            ++id;
        }

        if (sample) samples.push_back(std::chrono::duration<double, std::nano>(Clock::now() - t0).count());
        if (book.trades().size() > (1u << 16)) book.clearTrades();
    }
    const double secs = std::chrono::duration<double>(Clock::now() - start).count();

    return Result{n, secs, pct(samples, 0.50), pct(samples, 0.99), pct(samples, 0.999),
                  book.tradeCount(), book.liveOrders()};
}

// The stress case: one-directional panic flow, price walking down 10%, the book
// constantly crossing. Every order does real matching work.
Result crash(std::uint64_t n) {
    OrderBook book(n + (1u << 20));
    Rng rng;
    std::vector<double> samples;
    samples.reserve(n / 32 + 1);

    OrderId id = 1;
    for (int i = 1; i <= 2000; ++i) {
        book.submit(id++, Side::Buy,  OrderType::Limit, REF - i * TICK, 200);
        book.submit(id++, Side::Sell, OrderType::Limit, REF + i * TICK, 200);
    }
    book.clearTrades();

    const auto start = Clock::now();
    for (std::uint64_t i = 0; i < n; ++i) {
        const bool sample = (i & 31) == 0;
        const auto t0 = sample ? Clock::now() : Clock::time_point{};

        const double progress = static_cast<double>(i) / static_cast<double>(n);
        const Price ref = static_cast<Price>(REF * (1.0 - 0.10 * progress)) / TICK * TICK;

        const std::uint32_t r = rng.below(100);
        if (r < 55) {
            book.submit(id++, Side::Sell, OrderType::Limit, ref - static_cast<Price>(rng.below(20)) * TICK, 10 + rng.below(500));
        } else if (r < 70) {
            book.submit(id++, Side::Sell, OrderType::Market, 0, 10 + rng.below(200));
        } else {
            book.submit(id++, Side::Buy, OrderType::Limit, ref - static_cast<Price>(2 + rng.below(60)) * TICK, 10 + rng.below(500));
        }

        if (sample) samples.push_back(std::chrono::duration<double, std::nano>(Clock::now() - t0).count());
        if (book.trades().size() > (1u << 16)) book.clearTrades();
    }
    const double secs = std::chrono::duration<double>(Clock::now() - start).count();

    return Result{n, secs, pct(samples, 0.50), pct(samples, 0.99), pct(samples, 0.999),
                  book.tradeCount(), book.liveOrders()};
}

} // namespace

int main(int argc, char** argv) {
    const std::uint64_t n = (argc > 1) ? std::strtoull(argv[1], nullptr, 10) : 2000000;

    std::printf("mini order engine benchmark  (single thread, %llu orders per scenario)\n",
                static_cast<unsigned long long>(n));

    const Result a = steadyState(n);
    report("scenario 1 — steady state (passive quoting + 20% aggressive + 12% cancels)", a);

    const Result b = crash(n);
    report("scenario 2 — crash burst (one-way panic flow, price -10%)", b);

    return 0;
}
