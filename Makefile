CXX      ?= g++
CXXFLAGS := -std=c++17 -O2 -march=native -Wall -Wextra -Iinclude
LDFLAGS  :=
LDLIBS   :=

ifeq ($(OS),Windows_NT)
  LDLIBS  += -lws2_32
  # Static runtime: a MinGW binary that finds a different toolchain's
  # libstdc++-6.dll on PATH crashes in unrelated places.
  LDFLAGS += -static
  EXT     := .exe
else
  EXT     :=
endif

all: engine$(EXT) bench$(EXT)

engine$(EXT): src/main.cpp src/order_book.cpp include/order_book.hpp src/ws_server.hpp
	$(CXX) $(CXXFLAGS) $(LDFLAGS) src/main.cpp src/order_book.cpp -o $@ $(LDLIBS)

bench$(EXT): bench/bench.cpp src/order_book.cpp include/order_book.hpp
	$(CXX) $(CXXFLAGS) $(LDFLAGS) bench/bench.cpp src/order_book.cpp -o $@

clean:
	rm -f engine engine.exe bench bench.exe

.PHONY: all clean
