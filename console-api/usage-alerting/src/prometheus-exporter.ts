/**
 * Custom Prometheus Exporter for Quicknode Usage Metrics
 *
 * This exposes v0/usage/rpc data as Prometheus metrics, allowing you to:
 * - Build Grafana dashboards with usage limits and remaining credits
 * - Set up Prometheus alerting rules (AlertManager)
 * - Combine with metrics from other vendors in a single Prometheus instance
 * - View per-endpoint and per-chain credit attribution
 *
 * Run: npx ts-node src/prometheus-exporter.ts
 * Then configure Prometheus to scrape http://localhost:9091/metrics
 *
 * Environment variables:
 *   QUICKNODE_API_KEY     - Required. Your Quicknode API key.
 *   EXPORTER_PORT         - Optional. Port for metrics endpoint (default: 9091).
 *   ENABLE_METHOD_METRICS - Optional. Set to "true" to expose per-method metrics (default: false).
 */

import http from "http";

const PORT = parseInt(process.env.EXPORTER_PORT || "9091", 10);
const API_KEY = process.env.QUICKNODE_API_KEY;
const ENABLE_METHOD_METRICS = process.env.ENABLE_METHOD_METRICS === "true";

if (!API_KEY) {
  console.error("QUICKNODE_API_KEY is required");
  process.exit(1);
}

// --- Interfaces ---

interface UsageData {
  credits_used: number;
  credits_remaining: number | null;
  limit: number | null;
  overages: number | null;
  start_time: number;
  end_time: number;
}

interface UsageResponse {
  data: UsageData;
  error: string | null;
}

interface EndpointMethod {
  method_name: string;
  credits_used: number;
}

interface EndpointUsage {
  name: string;
  label: string;
  chain: string;
  status: string;
  network: string;
  credits_used: number;
  requests: number;
  archive: boolean;
  methods: EndpointMethod[];
}

interface EndpointUsageResponse {
  data: {
    endpoints: EndpointUsage[];
    start_time: number;
    end_time: number;
  };
  error: string | null;
}

interface ChainUsage {
  name: string;
  credits_used: number;
  start_time: number;
  end_time: number;
}

interface ChainUsageResponse {
  data: {
    chains: ChainUsage[];
  };
  error: string | null;
}

interface MethodUsage {
  method_name: string;
  credits_used: number;
  archive: boolean;
  start_time: number;
  end_time: number;
}

interface MethodUsageResponse {
  data: {
    methods: MethodUsage[];
  };
  error: string | null;
}

// --- API Fetch Functions ---

const API_HEADERS = {
  "x-api-key": API_KEY!,
  "Content-Type": "application/json",
};

async function fetchUsage(): Promise<UsageResponse> {
  const response = await fetch("https://api.quicknode.com/v0/usage/rpc", {
    method: "GET",
    headers: API_HEADERS,
  });

  if (!response.ok) {
    throw new Error(`API failed: ${response.status}`);
  }

  return response.json() as Promise<UsageResponse>;
}

async function fetchUsageByEndpoint(): Promise<EndpointUsageResponse> {
  const response = await fetch(
    "https://api.quicknode.com/v0/usage/rpc/by-endpoint",
    {
      method: "GET",
      headers: API_HEADERS,
    }
  );

  if (!response.ok) {
    throw new Error(`API by-endpoint failed: ${response.status}`);
  }

  return response.json() as Promise<EndpointUsageResponse>;
}

async function fetchUsageByChain(): Promise<ChainUsageResponse> {
  const response = await fetch(
    "https://api.quicknode.com/v0/usage/rpc/by-chain",
    {
      method: "GET",
      headers: API_HEADERS,
    }
  );

  if (!response.ok) {
    throw new Error(`API by-chain failed: ${response.status}`);
  }

  return response.json() as Promise<ChainUsageResponse>;
}

async function fetchUsageByMethod(): Promise<MethodUsageResponse> {
  const response = await fetch(
    "https://api.quicknode.com/v0/usage/rpc/by-method",
    {
      method: "GET",
      headers: API_HEADERS,
    }
  );

  if (!response.ok) {
    throw new Error(`API by-method failed: ${response.status}`);
  }

  return response.json() as Promise<MethodUsageResponse>;
}

// --- Prometheus Formatting ---

function escapePrometheusLabel(value: string | null | undefined): string {
  if (value == null) return "";
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");
}

function formatAggregateMetrics(usage: UsageData): string {
  const limit = usage.limit ?? 0;
  const creditsRemaining = usage.credits_remaining ?? 0;
  const overages = usage.overages ?? 0;
  const usagePercent = limit > 0 ? (usage.credits_used / limit) * 100 : 0;

  return `# HELP quicknode_credits_used Total RPC credits used in current billing period
# TYPE quicknode_credits_used gauge
quicknode_credits_used ${usage.credits_used}

# HELP quicknode_credits_remaining RPC credits remaining in current billing period
# TYPE quicknode_credits_remaining gauge
quicknode_credits_remaining ${creditsRemaining}

# HELP quicknode_credits_limit Total RPC credit limit for billing period
# TYPE quicknode_credits_limit gauge
quicknode_credits_limit ${limit}

# HELP quicknode_usage_percent Percentage of RPC credit limit used
# TYPE quicknode_usage_percent gauge
quicknode_usage_percent ${usagePercent.toFixed(2)}

# HELP quicknode_overages RPC credits used beyond the limit (overage charges)
# TYPE quicknode_overages gauge
quicknode_overages ${overages}
`;
}

function formatEndpointMetrics(
  data: EndpointUsageResponse["data"]
): string {
  const activeEndpoints = data.endpoints.filter(
    (e) => e.credits_used > 0 || e.requests > 0
  );
  if (activeEndpoints.length === 0) return "";

  let output = `# HELP quicknode_endpoint_credits_used RPC credits used per endpoint in current billing period
# TYPE quicknode_endpoint_credits_used gauge
# HELP quicknode_endpoint_requests Total requests per endpoint in current billing period
# TYPE quicknode_endpoint_requests gauge
`;

  for (const ep of activeEndpoints) {
    const labels = `name="${escapePrometheusLabel(ep.name)}",label="${escapePrometheusLabel(ep.label)}",chain="${escapePrometheusLabel(ep.chain)}",network="${escapePrometheusLabel(ep.network)}",status="${ep.status}"`;
    output += `quicknode_endpoint_credits_used{${labels}} ${ep.credits_used}\n`;
    output += `quicknode_endpoint_requests{${labels}} ${ep.requests}\n`;
  }

  return output;
}

function formatChainMetrics(data: ChainUsageResponse["data"]): string {
  const activeChains = data.chains.filter((c) => c.credits_used > 0);
  if (activeChains.length === 0) return "";

  let output = `# HELP quicknode_chain_credits_used RPC credits used per chain in current billing period
# TYPE quicknode_chain_credits_used gauge
`;

  for (const chain of activeChains) {
    output += `quicknode_chain_credits_used{chain="${escapePrometheusLabel(chain.name)}"} ${chain.credits_used}\n`;
  }

  return output;
}

function formatMethodMetrics(data: MethodUsageResponse["data"]): string {
  const activeMethods = data.methods.filter((m) => m.credits_used > 0);
  if (activeMethods.length === 0) return "";

  let output = `# HELP quicknode_method_credits_used RPC credits used per method in current billing period
# TYPE quicknode_method_credits_used gauge
`;

  for (const method of activeMethods) {
    output += `quicknode_method_credits_used{method="${escapePrometheusLabel(method.method_name)}",archive="${method.archive}"} ${method.credits_used}\n`;
  }

  return output;
}

function formatErrorMetrics(error: string): string {
  return `# HELP quicknode_exporter_scrape_success Whether the last scrape was successful (1=success, 0=failure)
# TYPE quicknode_exporter_scrape_success gauge
quicknode_exporter_scrape_success 0

# HELP quicknode_exporter_error_info Information about the last error
# TYPE quicknode_exporter_error_info gauge
quicknode_exporter_error_info{error="${escapePrometheusLabel(error)}"} 1
`;
}

// --- HTTP Server ---

const server = http.createServer(async (req, res) => {
  if (req.url === "/metrics") {
    try {
      const fetchPromises: [
        Promise<UsageResponse>,
        Promise<EndpointUsageResponse>,
        Promise<ChainUsageResponse>,
        Promise<MethodUsageResponse | null>,
      ] = [
        fetchUsage(),
        fetchUsageByEndpoint(),
        fetchUsageByChain(),
        ENABLE_METHOD_METRICS ? fetchUsageByMethod() : Promise.resolve(null),
      ];

      const [usageResponse, endpointResponse, chainResponse, methodResponse] =
        await Promise.all(fetchPromises);

      if (usageResponse.error) {
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(formatErrorMetrics(usageResponse.error));
        return;
      }

      let metrics = formatAggregateMetrics(usageResponse.data);

      if (!endpointResponse.error) {
        metrics += "\n" + formatEndpointMetrics(endpointResponse.data);
      }

      if (!chainResponse.error) {
        metrics += "\n" + formatChainMetrics(chainResponse.data);
      }

      if (methodResponse && !methodResponse.error) {
        metrics += "\n" + formatMethodMetrics(methodResponse.data);
      }

      metrics += `\n# HELP quicknode_exporter_scrape_success Whether the last scrape was successful (1=success, 0=failure)
# TYPE quicknode_exporter_scrape_success gauge
quicknode_exporter_scrape_success 1
`;

      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(metrics);
    } catch (err) {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(formatErrorMetrics(String(err)));
    }
  } else if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("OK");
  } else {
    res.writeHead(404);
    res.end("Not found. Try /metrics");
  }
});

server.listen(PORT, () => {
  console.log(
    `Quicknode Prometheus Exporter running on http://localhost:${PORT}`
  );
  console.log(`Metrics endpoint: http://localhost:${PORT}/metrics`);
  console.log(`Health endpoint:  http://localhost:${PORT}/health`);
  console.log(`Method metrics:   ${ENABLE_METHOD_METRICS ? "enabled" : "disabled (set ENABLE_METHOD_METRICS=true to enable)"}`);
});
