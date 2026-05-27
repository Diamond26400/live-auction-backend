# Real-Time Multiplayer Auction Hub (Backend Engine)

A high-frequency, real-time multiplayer game engine pipeline designed to synchronize game state variables across multiple concurrent client instances. Built as a dedicated middleware service, this system handles lightning-fast memory state checks to prevent transaction race conditions during live competitive events.

## 🚀 Architectural Overview

The engine leverages a dual-layer data tier approach to maintain ultra-low latency while guaranteeing absolute financial data persistence for player accounts:

* **In-Memory Cache (Redis):** Acts as the high-speed validation layer. Incoming client bids are cross-referenced against cached gold balances in microseconds, completely neutralizing race conditions before state mutation.
* **Persistent Storage (PostgreSQL):** Serves as the ultimate source of truth. Real-time rounds run strictly in memory; upon auction conclusion, the state engine triggers an asynchronous transaction to permanently deduct balances on disk.
* **Real-Time Transport (Socket.io):** Bypasses standard browser HTTP polling configurations to deliver instant TCP packet frames between the Node.js state manager and native Unity C# clients.

## 🛠️ Tech Stack
* **Runtime Environment:** Node.js / Express
* **Real-Time Networking:** Socket.io (WebSocket Protocol)
* **Caching Engine:** Redis (In-Memory Data Structures)
* **Database Management:** PostgreSQL (Connection Pooling)
* **Hosting Configuration:** Railway Cloud Platform

## 📡 Live Event Wire-Frame Protocol

The WebSocket connection operates using specialized structural JSON payloads mapped cleanly to native custom serializable data arrays on the client frontend:

* `join_auction`: Registers connected player sockets into highly optimized room channels.
* `submit_bid`: High-velocity input listener featuring guard clauses rejecting invalid bid amounts or insufficient player funds.
* `auction_tick`: Broadcasts global game loop timer count status values to all clients every second.
* `auction_concluded`: Implements the write-through database transactional safety routine.
