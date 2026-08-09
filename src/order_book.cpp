#include "order_book.hpp"

#include <algorithm>

namespace ome {

OrderBook::OrderBook(std::size_t capacity) {
    arena_.reserve(capacity);
    free_.reserve(capacity / 4);
    index_.reserve(capacity);
    trades_.reserve(1u << 16);
}

std::uint32_t OrderBook::alloc() {
    if (!free_.empty()) {
        std::uint32_t idx = free_.back();
        free_.pop_back();
        return idx;
    }
    arena_.emplace_back();
    return static_cast<std::uint32_t>(arena_.size() - 1);
}

void OrderBook::release(std::uint32_t idx) {
    free_.push_back(idx);
}

void OrderBook::unlink(Level& lv, std::uint32_t idx) {
    Order& o = arena_[idx];
    if (o.prev != NIL) arena_[o.prev].next = o.next; else lv.head = o.next;
    if (o.next != NIL) arena_[o.next].prev = o.prev; else lv.tail = o.prev;
    lv.qty -= o.qty;
    --lv.orders;
}

// Walks the opposite side from the best price outwards, filling FIFO within each
// level. Returns the unfilled remainder of the aggressing order.
template <class BookSide>
Qty OrderBook::match(BookSide& opposite, OrderId id, Side side, OrderType type, Price limit, Qty qty) {
    while (qty > 0 && !opposite.empty()) {
        auto it = opposite.begin();
        const Price lvlPrice = it->first;

        if (type != OrderType::Market) {
            const bool crosses = (side == Side::Buy) ? (lvlPrice <= limit) : (lvlPrice >= limit);
            if (!crosses) break;
        }

        Level& lv = it->second;
        while (qty > 0 && lv.head != NIL) {
            const std::uint32_t ridx = lv.head;
            Order& r = arena_[ridx];

            const Qty fill = std::min(qty, r.qty);
            r.qty -= fill;
            qty   -= fill;
            lv.qty -= fill;

            trades_.push_back(Trade{id, r.id, lvlPrice, fill, side, ++seq_});
            ++tradeCount_;
            volume_   += static_cast<std::uint64_t>(fill);
            lastPrice_ = lvlPrice;

            if (r.qty == 0) {
                lv.head = r.next;
                if (lv.head != NIL) arena_[lv.head].prev = NIL; else lv.tail = NIL;
                --lv.orders;
                index_.erase(r.id);
                release(ridx);
            }
        }

        if (lv.head == NIL) opposite.erase(it);
    }
    return qty;
}

void OrderBook::rest(OrderId id, Side side, OrderType type, Price price, Qty qty) {
    const std::uint32_t idx = alloc();
    Order& o = arena_[idx];
    o.id      = id;
    o.price   = price;
    o.qty     = qty;
    o.origQty = qty;
    o.side    = side;
    o.type    = type;
    o.prev    = NIL;
    o.next    = NIL;

    Level& lv = (side == Side::Buy) ? bids_[price] : asks_[price];
    if (lv.tail == NIL) {
        lv.head = idx;
    } else {
        arena_[lv.tail].next = idx;
        o.prev = lv.tail;
    }
    lv.tail = idx;
    lv.qty += qty;
    ++lv.orders;

    index_.emplace(id, idx);
}

ExecReport OrderBook::submit(OrderId id, Side side, OrderType type, Price price, Qty qty) {
    if (qty <= 0) return ExecReport{id, 0, 0, Status::RejectedQty};
    if (index_.count(id))  return ExecReport{id, 0, 0, Status::RejectedDupId};

    const Qty incoming = qty;

    if (type == OrderType::Market) {
        const bool empty = (side == Side::Buy) ? asks_.empty() : bids_.empty();
        if (empty) return ExecReport{id, 0, 0, Status::RejectedNoBook};
    }

    Qty left = (side == Side::Buy) ? match(asks_, id, side, type, price, qty)
                                   : match(bids_, id, side, type, price, qty);

    if (left == 0) return ExecReport{id, incoming, 0, Status::Filled};

    if (type == OrderType::Limit) {
        rest(id, side, type, price, left);
        return ExecReport{id, incoming - left, left, Status::Resting};
    }
    return ExecReport{id, incoming - left, 0, Status::Cancelled};
}

bool OrderBook::cancel(OrderId id) {
    auto it = index_.find(id);
    if (it == index_.end()) return false;

    const std::uint32_t idx = it->second;
    const Order& o = arena_[idx];

    if (o.side == Side::Buy) {
        auto lit = bids_.find(o.price);
        unlink(lit->second, idx);
        if (lit->second.head == NIL) bids_.erase(lit);
    } else {
        auto lit = asks_.find(o.price);
        unlink(lit->second, idx);
        if (lit->second.head == NIL) asks_.erase(lit);
    }

    index_.erase(it);
    release(idx);
    return true;
}

void OrderBook::clear() {
    bids_.clear();
    asks_.clear();
    index_.clear();
    free_.clear();
    arena_.clear();
    trades_.clear();
    seq_ = 0;
    tradeCount_ = 0;
    volume_ = 0;
    lastPrice_ = 0;
}

bool OrderBook::bestBid(Price& out) const {
    if (bids_.empty()) return false;
    out = bids_.begin()->first;
    return true;
}

bool OrderBook::bestAsk(Price& out) const {
    if (asks_.empty()) return false;
    out = asks_.begin()->first;
    return true;
}

bool OrderBook::lookup(OrderId id, Order& out) const {
    auto it = index_.find(id);
    if (it == index_.end()) return false;
    out = arena_[it->second];
    return true;
}

void OrderBook::depth(Side side, std::size_t levels, std::vector<LevelView>& out) const {
    out.clear();
    if (side == Side::Buy) {
        for (const auto& kv : bids_) {
            if (out.size() >= levels) break;
            out.push_back(LevelView{kv.first, kv.second.qty, kv.second.orders});
        }
    } else {
        for (const auto& kv : asks_) {
            if (out.size() >= levels) break;
            out.push_back(LevelView{kv.first, kv.second.qty, kv.second.orders});
        }
    }
}

} // namespace ome
