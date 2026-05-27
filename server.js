require('dotenv').config();
const express = require('express');
const http = require('http'); // Native Node HTTP module
const { Server } = require('socket.io'); // Socket.io server
const { Pool } = require('pg');
const { createClient } = require('redis');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

// Create HTTP Server to attach both Express and WebSockets
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*", // Allows your Unity build to connect from anywhere
        methods: ["GET", "POST"]
    }
});

app.use(cors());
app.use(express.json());

// 1. PostgreSQL Connection Pool
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
});

// 2. Redis Client Initialization
const redisClient = createClient({
    url: process.env.REDIS_URL
});

redisClient.on('error', (err) => console.error('❌ Redis Client Error:', err));

// Global Active Auction State (In-Memory Gameplay Loop)
let auctionState = {
    currentItem: "Mythic Obsidian Greatsword",
    highestBid: 100,
    highestBidder: "System",
    timer: 15, // 15-second countdown
    isActive: true
};

// Interval loop to run the live countdown every 1 second
let auctionCountdown; // File-scoped reference to the interval pointer

const startAuctionTimer = () => {
    // 1. Safety Guard: Kill any existing interval loop before spinning up a new one
    if (auctionCountdown) {
        clearInterval(auctionCountdown);
    }

    // 2. Hard Reset: Force the state to be freshly active and full
    auctionState.isActive = true;
    auctionState.timer = 15;
    auctionState.highestBid = 100;
    auctionState.highestBidder = "System";

    console.log("⏱️ Game Loop Reset: Fresh 15-second auction loop initialized.");

    auctionCountdown = setInterval(() => {
        if (auctionState.timer > 0) {
            auctionState.timer--;
            
            io.to('auction_room').emit('auction_tick', {
                timer: auctionState.timer,
                highest_bid: auctionState.highestBid,
                highest_bidder: auctionState.highestBidder
            });
        } else {
            clearInterval(auctionCountdown);
            finalizeAuction();
        }
    }, 1000);
};

const finalizeAuction = async () => {
    auctionState.isActive = false;
    const winner = auctionState.highestBidder;
    const finalPrice = auctionState.highestBid;

    console.log(`🏆 Auction ended! Processing settlement for Winner: ${winner} at ${finalPrice} Gold.`);

    // If the system won, no financial transactions need to occur
    if (winner === "System") {
        return io.to('auction_room').emit('auction_concluded', {
            winner,
            final_price: finalPrice,
            message: "Auction closed with no player bids."
        });
    }

    try {
        const redisKey = `player:${winner}:gold`;

        // 1. High-Speed Cache Ledger Mutation
        const cachedGold = await redisClient.get(redisKey) || "1000";
        const currentBalance = parseInt(cachedGold);
        const newBalance = currentBalance - finalPrice;

        // Save the updated deduction back into Redis immediately
        await redisClient.set(redisKey, newBalance.toString());
        console.log(`⚡ Redis Balance Settled: ${winner} now has ${newBalance} Gold in cache.`);

        // 2. Persistent Database Write (Source of Truth)
        const updateDbQuery = `
            UPDATE players 
            SET gold_balance = $1 
            WHERE username = $2 
            RETURNING *;
        `;
        const dbRes = await pool.query(updateDbQuery, [newBalance, winner]);
        
        if (dbRes.rows.length > 0) {
            console.log(`💾 PostgreSQL Guard: Hard disk updated permanently for ${winner}. Balance: ${dbRes.rows[0].gold_balance} Gold.`);
        }

        // 3. Broadcast Finality Frame to everyone in Unity
        io.to('auction_room').emit('auction_concluded', {
            winner: winner,
            final_price: finalPrice,
            remaining_balance: newBalance
        });

    } catch (err) {
        console.error("❌ CRITICAL TRANSACTION FAILURE DURING SETTLE:", err);
        io.to('auction_room').emit('auction_error', { message: "Settlement processing crash." });
    }
};
// Initialize Services
const initServices = async () => {
    const createTableQuery = `
        CREATE TABLE IF NOT EXISTS players (
            id SERIAL PRIMARY KEY,
            username VARCHAR(50) UNIQUE NOT NULL,
            gold_balance INTEGER DEFAULT 1000
        );
    `;
    try {
        await pool.query(createTableQuery);
        console.log("✅ Database connected and 'players' table verified.");
        
        await redisClient.connect();
        console.log("⚡ Redis cache connected and ready.");
        
        // Start the auction clock once systems are green
        
    } catch (err) {
        console.error("❌ Service initialization error:", err);
    }
};

initServices();

// 3. Live WebSocket Event Handling (The Real-Time Gate)
io.on('connection', (socket) => {
    console.log(`🔌 Player Connected! Socket ID: ${socket.id}`);

    // Listen directly for the 'join_auction' event from Unity
    socket.on('join_auction', async (eventData) => {
        try {
            const { username } = eventData;
            socket.join('auction_room');
            console.log(`👤 Player ${username} successfully verified and moved to Auction Room.`);

            // REACTIVE TRIGGER: If the auction is dead or resting, start it now that a player is here!
            if (!auctionCountdown || !auctionState.isActive) {
                startAuctionTimer();
            }

            // Pull current balance directly from high-speed Redis cache
            const redisKey = `player:${username}:gold`;
            const cachedGold = await redisClient.get(redisKey) || "1000";

            // Send confirmation back to this specific player
            socket.emit('auction_joined', {
                username: username,
                gold_balance: parseInt(cachedGold)
            });
        } catch (err) {
            console.error("❌ Redis read error during join:", err);
        }
    });
    // Listen for incoming live bids from Unityz
    socket.on('submit_bid', async (eventData) => {
        try {
            const { username, bidAmount } = eventData;

          // Guard Clauses: Reject if auction over (unless it's a System developer reset)
            if (!auctionState.isActive && username !== "System") {
                return socket.emit('bid_rejected', { reason: "Auction has already concluded." });
            }

            // If it IS a system reset frame, force the engine awake!
            if (username === "System") {
                auctionState.isActive = true;
                console.log("🛠️ Dev Reset Triggered: Forcing room loop to wake up...");
            }
            // High-Speed Balance Verification via Redis
            const redisKey = `player:${username}:gold`;
            const cachedGold = await redisClient.get(redisKey) || "1000";
            const currentBalance = parseInt(cachedGold);

            if (currentBalance < bidAmount) {
                return socket.emit('bid_rejected', { reason: "Insufficient gold balance in your cache." });
            }

            // State Mutation: Update the global leader
            auctionState.highestBid = bidAmount;
            auctionState.highestBidder = username;
            auctionState.timer = 15; // Reset the clock! (Sniper protection mechanic)

            console.log(`🔥 New High Bid! ${username} bid ${bidAmount} Gold on ${auctionState.currentItem}`);

            // Global Broadcast: Tell EVERY player instantly about the new bid state
            io.to('auction_room').emit('bid_updated', {
                highest_bid: auctionState.highestBid,
                highest_bidder: auctionState.highestBidder,
                timer: auctionState.timer
            });

        } catch (err) {
            console.error("❌ High-frequency bid processing error:", err);
            socket.emit('bid_rejected', { reason: "Internal engine latency error." });
        }
    });

    socket.on('disconnect', () => {
        console.log(`❌ Player disconnected. Socket ID: ${socket.id}`);
    });
});

// Register or Login Player & Initialize Cache
app.post('/api/login', async (req, res) => {
    const { username } = req.body;

    if (!username) {
        return res.status(400).json({ error: "Username is required" });
    }

    try {
        // 1. Check or Insert into PostgreSQL (Source of Truth)
        let playerRes = await pool.query(
            'SELECT * FROM players WHERE username = $1', 
            [username]
        );

        if (playerRes.rows.length === 0) {
            playerRes = await pool.query(
                'INSERT INTO players (username, gold_balance) VALUES ($1, $2) RETURNING *',
                [username, 1000] // Default 1000 Gold
            );
            console.log(`💾 Created new player in Postgres: ${username}`);
        }

        const player = playerRes.rows[0];

        // 2. Clone the Gold Balance into Redis Cache (High-Speed Arena)
        const redisKey = `player:${username}:gold`;
        await redisClient.set(redisKey, player.gold_balance.toString());
        console.log(`⚡ Cached balance for ${username} in Redis: ${player.gold_balance} Gold`);

        // Respond to client
        res.json({
            id: player.id,
            username: player.username,
            gold_balance: player.gold_balance,
            message: "Successfully synchronized database and high-speed cache."
        });

    } catch (err) {
        console.error("❌ Login/Cache sync error:", err);
        res.status(500).json({ error: "Server sync failed" });
    }
});

// Health Check Route
app.get('/', (req, res) => {
    res.json({ status: "Auction Hub WebSocket API is live." });
});

// Start listening via native server instance
server.listen(port, () => {
    console.log(`🚀 Server listening on port ${port}`);
});