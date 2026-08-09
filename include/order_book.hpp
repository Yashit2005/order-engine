#pragma once

#include <cstdint>
#include <cstddef>
#include <map>
#include <vector>
#include <unordered_map>
#include <functional>

namespace ome {

using Price   = std::int64_t;   // integer ticks (paise); 250000 == Rs. 2500.00
using Qty     = std::int64_t;
using OrderId = std::uint64_t;

inline constexpr std::uint32_t NIL = 0xFFFFFFFFu;

enum class Side : std::uint8_t { Buy = 0, Sell = 1 };
enum class OrderType : std::uint8_t { Limit = 0, Market = 1, IOC = 2 };

enum class Status : std::uint8_t {
    Resting,        // fully or partially resting on the book
    Filled,         // completely matched
    Cancelled,      // unfilled remainder killed (Market / IOC)
    RejectedQty,
    RejectedDupId,
    RejectedNoBook  // market order against an empty opposite side
};

struct Trade {
    OrderId       aggressor;
    OrderId       resting;
    Price         price;
    Qty           qty;
    Side          aggressorSide;
    std::uint64_t seq;
};

struct ExecReport {
    OrderId id;
    Qty     filled;
    Qty     resting;
    Status  status;
};

struct LevelView {
    Price         price;
    Qty           qty;
    std::uint32_t orders;
};

// One resting order. Links are arena indices rather than pointers so the arena
// can grow without invalidating the book.
struct Order {
    OrderId       id;
    Price         price;
    Qty           qty;
    Qty           origQty;
    std::uint32_t prev;
    std::uint32_t next;
    Side          side;
    OrderType     type;
};

// FIFO queue of orders at a single price. Time priority is the list order.
struct Level {
    std::uint32_t head   = NIL;
    std::uint32_t tail   = NIL;
    Qty           qty    = 0;
    std::uint32_t orders = 0;
};

// Price-time priority limit order book.
//
//   price levels : std::map        -> O(log P) to reach a level, O(1) for the best
//   time queue   : intrusive list  -> O(1) push-back / pop-front at a level
//   id lookup    : hash map        -> O(1) cancel, no scan of the book
//   order storage: slab + freelist -> no per-order allocation on the hot path
class OrderBook {
public:
    explicit OrderBook(std::size_t capacity = 1u << 20);

    ExecReport submit(OrderId id, Side side, OrderType type, Price price, Qty qty);
    bool       cancel(OrderId id);
    void       clear();

    bool bestBid(Price& out) const;
    bool bestAsk(Price& out) const;
    bool lookup(OrderId id, Order& out) const;
    void depth(Side side, std::size_t levels, std::vector<LevelView>& out) const;

    const std::vector<Trade>& trades() const { return trades_; }
    void  clearTrades() { trades_.clear(); }

    std::size_t   liveOrders()  const { return index_.size(); }
    std::size_t   bidLevels()   const { return bids_.size(); }
    std::size_t   askLevels()   const { return asks_.size(); }
    std::uint64_t tradeCount()  const { return tradeCount_; }
    std::uint64_t volume()      const { return volume_; }
    Price         lastPrice()   const { return lastPrice_; }

private:
    std::uint32_t alloc();
    void          release(std::uint32_t idx);

    template <class BookSide>
    Qty match(BookSide& opposite, OrderId id, Side side, OrderType type, Price limit, Qty qty);

    void rest(OrderId id, Side side, OrderType type, Price price, Qty qty);
    void unlink(Level& lv, std::uint32_t idx);

    std::map<Price, Level, std::greater<Price>> bids_;
    std::map<Price, Level, std::less<Price>>    asks_;

    std::vector<Order>                        arena_;
    std::vector<std::uint32_t>                free_;
    std::unordered_map<OrderId, std::uint32_t> index_;

    std::vector<Trade> trades_;
    std::uint64_t      seq_        = 0;
    std::uint64_t      tradeCount_ = 0;
    std::uint64_t      volume_     = 0;
    Price              lastPrice_  = 0;
};

} // namespace ome
