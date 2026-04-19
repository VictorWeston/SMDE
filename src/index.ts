import dotenv from "dotenv";
dotenv.config();

import express from "express";
import { checkDbHealth } from "./db/connection";

const app = express();
const PORT = parseInt(process.env.PORT || "3000", 10);

app.use(express.json());

app.get("/", (_req, res) => {
  res.json({ message: "SMDE API is running" });
});

app.get("/api/health", async (_req, res) => {
  const dbOk = await checkDbHealth();

  const status = dbOk ? "OK" : "DEGRADED";

  res.status(dbOk ? 200 : 503).json({
    status,
    version: "1.0.0",
    uptime: Math.floor(process.uptime()),
    dependencies: {
      database: dbOk ? "OK" : "UNAVAILABLE",
      llmProvider: "OK",
      queue: "OK",
    },
    timestamp: new Date().toISOString(),
  });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
