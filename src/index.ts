import dotenv from "dotenv";
dotenv.config();

import express from "express";
import { checkDbHealth } from "./db/connection";
import { getLLMProvider } from "./llm";
import extractRouter from "./routes/extract";
import { errorHandler } from "./middleware/error-handler";

const app = express();
const PORT = parseInt(process.env.PORT || "3000", 10);

app.use(express.json());

app.get("/", (_req, res) => {
  res.json({ message: "SMDE API is running" });
});

app.get("/api/health", async (_req, res) => {
  let llmOk = false;
  try {
    llmOk = await getLLMProvider().checkHealth();
  } catch {
    // Provider not configured — treated as unavailable
  }

  const dbOk = await checkDbHealth();
  const allOk = dbOk && llmOk;
  const status = allOk ? "OK" : "DEGRADED";

  res.status(allOk ? 200 : 503).json({
    status,
    version: "1.0.0",
    uptime: Math.floor(process.uptime()),
    dependencies: {
      database: dbOk ? "OK" : "UNAVAILABLE",
      llmProvider: llmOk ? "OK" : "UNAVAILABLE",
      queue: "OK",
    },
    timestamp: new Date().toISOString(),
  });
});

// ── Routes ──────────────────────────────────────────────────
app.use("/api/extract", extractRouter);

// ── Global error handler ────────────────────────────────────
app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
