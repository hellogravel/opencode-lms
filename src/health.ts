import { LMSClient } from "./api-client.js";
import type { HealthCheckResult } from "./types.js";

const DEFAULT_PORTS = [1234, 8080, 11434];

/**
 * Check if LM Studio is running and accessible at any common port on localhost.
 * Auth isn't typically configured for the local server, but the apiKey param
 * lets callers cover the case where it is.
 */
export async function detectLMStudio(
  ports: number[] = DEFAULT_PORTS,
  apiKey?: string,
): Promise<HealthCheckResult | null> {
  for (const port of ports) {
    const baseURL = `http://127.0.0.1:${port}`;
    try {
      const client = new LMSClient({ baseURL, apiKey });
      const result = await client.checkHealth();
      if (result.healthy) return result;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Validate that a given baseURL is reachable. apiKey is required when the
 * target server has auth enabled — without it, every probe returns 401.
 */
export async function validateServer(baseURL: string, apiKey?: string): Promise<HealthCheckResult> {
  const client = new LMSClient({ baseURL, apiKey });
  return client.checkHealth();
}

