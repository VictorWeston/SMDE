import { AppConfig } from "../types";

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

export function loadConfig(): AppConfig {
  return {
    port: parseInt(process.env.PORT || "3000", 10),
    databaseUrl: requireEnv("DATABASE_URL"),
    llm: {
      provider: requireEnv("LLM_PROVIDER"),
      model: requireEnv("LLM_MODEL"),
      apiKey: requireEnv("LLM_API_KEY"),
    },
  };
}
