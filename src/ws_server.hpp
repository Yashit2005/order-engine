#pragma once

// Minimal HTTP + WebSocket (RFC 6455) server. No external dependencies:
// static files for the UI, a WebSocket endpoint at /ws for the live feed.

#include <cctype>
#include <cerrno>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <functional>
#include <sstream>
#include <string>
#include <unordered_map>
#include <vector>

#ifdef _WIN32
  #ifndef WIN32_LEAN_AND_MEAN
    #define WIN32_LEAN_AND_MEAN
  #endif
  #include <winsock2.h>
  #include <ws2tcpip.h>
  using socket_t = SOCKET;
  #define CLOSESOCK closesocket
#else
  #include <arpa/inet.h>
  #include <fcntl.h>
  #include <netinet/in.h>
  #include <netinet/tcp.h>
  #include <sys/select.h>
  #include <sys/socket.h>
  #include <unistd.h>
  using socket_t = int;
  #define INVALID_SOCKET (-1)
  #define CLOSESOCK ::close
#endif

namespace net {

// ---------------------------------------------------------------- SHA-1 + base64
// Required by the RFC 6455 handshake: base64(sha1(key + magic-guid)).
inline void sha1(const std::uint8_t* data, std::size_t len, std::uint8_t out[20]) {
    std::uint32_t h[5] = {0x67452301u, 0xEFCDAB89u, 0x98BADCFEu, 0x10325476u, 0xC3D2E1F0u};
    const std::uint64_t bits = static_cast<std::uint64_t>(len) * 8;

    std::vector<std::uint8_t> msg(data, data + len);
    msg.push_back(0x80);
    while (msg.size() % 64 != 56) msg.push_back(0);
    for (int i = 7; i >= 0; --i) msg.push_back(static_cast<std::uint8_t>(bits >> (i * 8)));

    for (std::size_t off = 0; off < msg.size(); off += 64) {
        std::uint32_t w[80];
        for (int i = 0; i < 16; ++i) {
            w[i] = (std::uint32_t(msg[off + i * 4]) << 24) | (std::uint32_t(msg[off + i * 4 + 1]) << 16) |
                   (std::uint32_t(msg[off + i * 4 + 2]) << 8) | std::uint32_t(msg[off + i * 4 + 3]);
        }
        for (int i = 16; i < 80; ++i) {
            const std::uint32_t v = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
            w[i] = (v << 1) | (v >> 31);
        }
        std::uint32_t a = h[0], b = h[1], c = h[2], d = h[3], e = h[4];
        for (int i = 0; i < 80; ++i) {
            std::uint32_t f, k;
            if (i < 20)      { f = (b & c) | (~b & d);            k = 0x5A827999u; }
            else if (i < 40) { f = b ^ c ^ d;                     k = 0x6ED9EBA1u; }
            else if (i < 60) { f = (b & c) | (b & d) | (c & d);   k = 0x8F1BBCDCu; }
            else             { f = b ^ c ^ d;                     k = 0xCA62C1D6u; }
            const std::uint32_t t = ((a << 5) | (a >> 27)) + f + e + k + w[i];
            e = d; d = c; c = (b << 30) | (b >> 2); b = a; a = t;
        }
        h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e;
    }
    for (int i = 0; i < 5; ++i)
        for (int j = 3; j >= 0; --j) out[i * 4 + (3 - j)] = static_cast<std::uint8_t>(h[i] >> (j * 8));
}

inline std::string base64(const std::uint8_t* data, std::size_t len) {
    static const char* T = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out;
    out.reserve(((len + 2) / 3) * 4);
    for (std::size_t i = 0; i < len; i += 3) {
        const std::uint32_t a = data[i];
        const std::uint32_t b = (i + 1 < len) ? data[i + 1] : 0;
        const std::uint32_t c = (i + 2 < len) ? data[i + 2] : 0;
        const std::uint32_t n = (a << 16) | (b << 8) | c;
        out += T[(n >> 18) & 63];
        out += T[(n >> 12) & 63];
        out += (i + 1 < len) ? T[(n >> 6) & 63] : '=';
        out += (i + 2 < len) ? T[n & 63] : '=';
    }
    return out;
}

// ---------------------------------------------------------------- server
class WsServer {
public:
    using MessageFn = std::function<void(int, const std::string&)>;
    using ConnectFn = std::function<void(int)>;

    ~WsServer() { stop(); }

    bool start(std::uint16_t port, std::string docroot) {
        docroot_ = std::move(docroot);
#ifdef _WIN32
        WSADATA wsa;
        if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) return false;
#endif
        listen_ = ::socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
        if (listen_ == INVALID_SOCKET) return false;

        int yes = 1;
        ::setsockopt(listen_, SOL_SOCKET, SO_REUSEADDR, reinterpret_cast<const char*>(&yes), sizeof(yes));

        sockaddr_in addr{};
        addr.sin_family      = AF_INET;
        addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        addr.sin_port        = htons(port);

        if (::bind(listen_, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) != 0) return false;
        if (::listen(listen_, 64) != 0) return false;
        setNonBlocking(listen_);
        return true;
    }

    void stop() {
        for (auto& kv : clients_) CLOSESOCK(kv.second.fd);
        clients_.clear();
        if (listen_ != INVALID_SOCKET) { CLOSESOCK(listen_); listen_ = INVALID_SOCKET; }
#ifdef _WIN32
        WSACleanup();
#endif
    }

    void onMessage(MessageFn fn) { onMessage_ = std::move(fn); }
    void onOpen(ConnectFn fn)    { onOpen_    = std::move(fn); }

    // Accepts, reads and dispatches for up to timeoutMs. Call in a loop.
    void poll(int timeoutMs) {
        fd_set rd;
        FD_ZERO(&rd);
        FD_SET(listen_, &rd);
        socket_t maxfd = listen_;
        for (auto& kv : clients_) {
            FD_SET(kv.second.fd, &rd);
            if (kv.second.fd > maxfd) maxfd = kv.second.fd;
        }

        timeval tv{timeoutMs / 1000, (timeoutMs % 1000) * 1000};
        const int n = ::select(static_cast<int>(maxfd) + 1, &rd, nullptr, nullptr, &tv);
        if (n <= 0) return;

        if (FD_ISSET(listen_, &rd)) accept();

        std::vector<int> dead;
        for (auto& kv : clients_) {
            if (!FD_ISSET(kv.second.fd, &rd)) continue;
            if (!recvInto(kv.first, kv.second)) dead.push_back(kv.first);
        }
        for (int id : dead) drop(id);
    }

    void send(int id, const std::string& payload) {
        auto it = clients_.find(id);
        if (it == clients_.end() || !it->second.upgraded) return;
        sendFrame(it->second.fd, payload);
    }

    void broadcast(const std::string& payload) {
        if (clients_.empty()) return;
        const std::string frame = buildFrame(payload);
        for (auto& kv : clients_)
            if (kv.second.upgraded) sendRaw(kv.second.fd, frame.data(), frame.size());
    }

    std::size_t clientCount() const { return clients_.size(); }

private:
    struct Client {
        socket_t    fd = INVALID_SOCKET;
        std::string in;
        bool        upgraded = false;
    };

    static void setNonBlocking(socket_t fd) {
#ifdef _WIN32
        u_long mode = 1;
        ioctlsocket(fd, FIONBIO, &mode);
#else
        fcntl(fd, F_SETFL, fcntl(fd, F_GETFL, 0) | O_NONBLOCK);
#endif
    }

    void accept() {
        const socket_t fd = ::accept(listen_, nullptr, nullptr);
        if (fd == INVALID_SOCKET) return;
        setNonBlocking(fd);
        int yes = 1;
        ::setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, reinterpret_cast<const char*>(&yes), sizeof(yes));
        clients_[nextId_++].fd = fd;
    }

    void drop(int id) {
        auto it = clients_.find(id);
        if (it == clients_.end()) return;
        CLOSESOCK(it->second.fd);
        clients_.erase(it);
    }

    static void sendRaw(socket_t fd, const char* data, std::size_t len) {
        std::size_t sent = 0;
        while (sent < len) {
            const int n = ::send(fd, data + sent, static_cast<int>(len - sent), 0);
            if (n <= 0) return;
            sent += static_cast<std::size_t>(n);
        }
    }

    static std::string buildFrame(const std::string& payload) {
        std::string f;
        f.reserve(payload.size() + 10);
        f += static_cast<char>(0x81); // FIN + text
        const std::size_t n = payload.size();
        if (n < 126) {
            f += static_cast<char>(n);
        } else if (n <= 0xFFFF) {
            f += static_cast<char>(126);
            f += static_cast<char>((n >> 8) & 0xFF);
            f += static_cast<char>(n & 0xFF);
        } else {
            f += static_cast<char>(127);
            for (int i = 7; i >= 0; --i) f += static_cast<char>((static_cast<std::uint64_t>(n) >> (i * 8)) & 0xFF);
        }
        f += payload;
        return f;
    }

    static void sendFrame(socket_t fd, const std::string& payload) {
        const std::string f = buildFrame(payload);
        sendRaw(fd, f.data(), f.size());
    }

    bool recvInto(int id, Client& c) {
        char buf[16384];
        for (;;) {
            const int n = ::recv(c.fd, buf, sizeof(buf), 0);
            if (n > 0) {
                c.in.append(buf, static_cast<std::size_t>(n));
                if (static_cast<std::size_t>(n) < sizeof(buf)) break;
                continue;
            }
            if (n == 0) return false;
#ifdef _WIN32
            if (WSAGetLastError() == WSAEWOULDBLOCK) break;
#else
            if (errno == EAGAIN || errno == EWOULDBLOCK) break;
#endif
            return false;
        }
        return c.upgraded ? consumeFrames(id, c) : consumeHttp(id, c);
    }

    // ------------------------------------------------------------ HTTP
    bool consumeHttp(int id, Client& c) {
        const std::size_t end = c.in.find("\r\n\r\n");
        if (end == std::string::npos) return true; // wait for the rest

        const std::string head = c.in.substr(0, end);
        c.in.erase(0, end + 4);

        const std::string key = header(head, "sec-websocket-key");
        if (!key.empty()) {
            static const char* GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
            const std::string cat = key + GUID;
            std::uint8_t digest[20];
            sha1(reinterpret_cast<const std::uint8_t*>(cat.data()), cat.size(), digest);

            std::string resp = "HTTP/1.1 101 Switching Protocols\r\n"
                               "Upgrade: websocket\r\nConnection: Upgrade\r\n"
                               "Sec-WebSocket-Accept: " + base64(digest, 20) + "\r\n\r\n";
            sendRaw(c.fd, resp.data(), resp.size());
            c.upgraded = true;
            if (onOpen_) onOpen_(id);
            return true;
        }

        serveFile(c, requestPath(head));
        return false; // plain HTTP: one response per connection
    }

    static std::string requestPath(const std::string& head) {
        const std::size_t s = head.find(' ');
        if (s == std::string::npos) return "/";
        const std::size_t e = head.find(' ', s + 1);
        std::string path = head.substr(s + 1, e - s - 1);
        const std::size_t q = path.find('?');
        if (q != std::string::npos) path.resize(q);
        return path;
    }

    static std::string header(const std::string& head, const std::string& name) {
        std::istringstream ss(head);
        std::string line;
        while (std::getline(ss, line)) {
            const std::size_t colon = line.find(':');
            if (colon == std::string::npos) continue;
            std::string k = line.substr(0, colon);
            for (char& ch : k) ch = static_cast<char>(::tolower(static_cast<unsigned char>(ch)));
            if (k != name) continue;
            std::string v = line.substr(colon + 1);
            while (!v.empty() && (v.front() == ' ' || v.front() == '\t')) v.erase(v.begin());
            while (!v.empty() && (v.back() == '\r' || v.back() == '\n' || v.back() == ' ')) v.pop_back();
            return v;
        }
        return {};
    }

    void serveFile(Client& c, std::string path) {
        if (path == "/") path = "/index.html";
        // Refuse anything that could escape the document root.
        if (path.find("..") != std::string::npos || path.find('\\') != std::string::npos) {
            static const char* bad = "HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n";
            sendRaw(c.fd, bad, std::strlen(bad));
            return;
        }

        std::ifstream f(docroot_ + path, std::ios::binary);
        if (!f) {
            static const char* nf = "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n";
            sendRaw(c.fd, nf, std::strlen(nf));
            return;
        }
        std::ostringstream body;
        body << f.rdbuf();
        const std::string data = body.str();

        std::string ctype = "text/plain";
        if (path.size() > 5 && path.compare(path.size() - 5, 5, ".html") == 0) ctype = "text/html; charset=utf-8";
        else if (path.size() > 3 && path.compare(path.size() - 3, 3, ".js") == 0) ctype = "application/javascript";
        else if (path.size() > 4 && path.compare(path.size() - 4, 4, ".css") == 0) ctype = "text/css";

        std::ostringstream resp;
        resp << "HTTP/1.1 200 OK\r\nContent-Type: " << ctype
             << "\r\nContent-Length: " << data.size() << "\r\nConnection: close\r\n\r\n" << data;
        const std::string out = resp.str();
        sendRaw(c.fd, out.data(), out.size());
    }

    // ------------------------------------------------------------ WebSocket frames
    bool consumeFrames(int id, Client& c) {
        for (;;) {
            if (c.in.size() < 2) return true;
            const std::uint8_t b0 = static_cast<std::uint8_t>(c.in[0]);
            const std::uint8_t b1 = static_cast<std::uint8_t>(c.in[1]);
            const std::uint8_t opcode = b0 & 0x0F;
            const bool masked = (b1 & 0x80) != 0;

            std::uint64_t len = b1 & 0x7F;
            std::size_t   off = 2;
            if (len == 126) {
                if (c.in.size() < 4) return true;
                len = (std::uint64_t(std::uint8_t(c.in[2])) << 8) | std::uint8_t(c.in[3]);
                off = 4;
            } else if (len == 127) {
                if (c.in.size() < 10) return true;
                len = 0;
                for (int i = 0; i < 8; ++i) len = (len << 8) | std::uint8_t(c.in[2 + i]);
                off = 10;
            }

            std::uint8_t mask[4] = {0, 0, 0, 0};
            if (masked) {
                if (c.in.size() < off + 4) return true;
                for (int i = 0; i < 4; ++i) mask[i] = static_cast<std::uint8_t>(c.in[off + i]);
                off += 4;
            }
            if (c.in.size() < off + len) return true;

            std::string payload = c.in.substr(off, static_cast<std::size_t>(len));
            if (masked)
                for (std::size_t i = 0; i < payload.size(); ++i)
                    payload[i] = static_cast<char>(static_cast<std::uint8_t>(payload[i]) ^ mask[i & 3]);
            c.in.erase(0, off + static_cast<std::size_t>(len));

            if (opcode == 0x8) return false; // close
            if (opcode == 0x1 && onMessage_) onMessage_(id, payload);
        }
    }

    socket_t                        listen_ = INVALID_SOCKET;
    std::unordered_map<int, Client> clients_;
    int                             nextId_ = 1;
    std::string                     docroot_;
    MessageFn                       onMessage_;
    ConnectFn                       onOpen_;
};

} // namespace net
