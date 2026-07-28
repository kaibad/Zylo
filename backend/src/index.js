require("dotenv").config();
const express = require("express");
const cors = require("cors");
const client = require("prom-client");
const postRoutes = require("./routes/posts");
const commentRoutes = require("./routes/comments");
const authRoutes = require("./routes/auth");
const db = require("./db");

const app = express();
const PORT = process.env.PORT || 5000;

// Prometheus default metrics
client.collectDefaultMetrics({ prefix: "zylo_backend_" });

// Middleware
app.use(cors());
app.use(express.json());

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", message: "ZYLO API is running" });
});

// Metrics endpoint                               // ADD THIS BLOCK
app.get("/metrics", async (req, res) => {
  res.set("Content-Type", client.register.contentType);
  res.end(await client.register.metrics());
});

// Routes
app.use("/api/auth", authRoutes);
app.use("/api/posts", postRoutes);
app.use("/api/comments", commentRoutes);

// Initialize database and start server
async function start() {
  try {
    await db.initDB();
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`ZYLO backend running on port ${PORT}`);
    });
  } catch (err) {
    console.error("Failed to start server:", err);
    process.exit(1);
  }
}

start();
