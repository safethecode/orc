export interface McpCatalogEntry {
  name: string;
  description: string;
  command: string;
  args: string[];
  envHint?: string;
}

export const MCP_CATALOG: McpCatalogEntry[] = [
  // ── Reference Servers (official) ───────────────────────────────────
  {
    name: "fetch",
    description: "Web content fetching and conversion for efficient LLM usage",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-fetch"],
  },
  {
    name: "filesystem",
    description: "Secure file operations with configurable access controls",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
  },
  {
    name: "git",
    description: "Read, search, and manipulate Git repositories",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-git"],
  },
  {
    name: "memory",
    description: "Knowledge graph-based persistent memory system",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-memory"],
  },
  {
    name: "sequential-thinking",
    description: "Dynamic and reflective problem-solving through thought sequences",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
  },
  {
    name: "time",
    description: "Time and timezone conversion capabilities",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-time"],
  },

  // ── Database ───────────────────────────────────────────────────────
  {
    name: "postgres",
    description: "PostgreSQL database interaction and business intelligence queries",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-postgres"],
    envHint: "POSTGRES_CONNECTION_STRING",
  },
  {
    name: "sqlite",
    description: "SQLite database operations and queries",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-sqlite"],
  },
  {
    name: "mongo",
    description: "MongoDB database queries and operations",
    command: "npx",
    args: ["-y", "@anthropic/mongo-mcp"],
    envHint: "MONGO_URI",
  },
  {
    name: "redis",
    description: "Redis cache and data structure operations",
    command: "npx",
    args: ["-y", "@anthropic/redis-mcp"],
    envHint: "REDIS_URL",
  },
  {
    name: "mysql",
    description: "MySQL database interaction and queries",
    command: "npx",
    args: ["-y", "@anthropic/mysql-mcp"],
    envHint: "MYSQL_CONNECTION_STRING",
  },

  // ── Development & DevOps ───────────────────────────────────────────
  {
    name: "github",
    description: "GitHub repository management, issues, PRs, and API integration",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    envHint: "GITHUB_TOKEN",
  },
  {
    name: "gitlab",
    description: "GitLab project management, issues, and merge requests",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-gitlab"],
    envHint: "GITLAB_TOKEN",
  },
  {
    name: "linear",
    description: "Linear issue tracking — search, create, and update issues",
    command: "npx",
    args: ["-y", "@anthropic/linear-mcp"],
    envHint: "LINEAR_API_KEY",
  },
  {
    name: "sentry",
    description: "Sentry error monitoring — retrieve and analyze issues",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-sentry"],
    envHint: "SENTRY_AUTH_TOKEN",
  },
  {
    name: "docker",
    description: "Docker container management — list, start, stop, inspect containers and images",
    command: "npx",
    args: ["-y", "@anthropic/docker-mcp"],
  },

  // ── Web & Search ───────────────────────────────────────────────────
  {
    name: "brave-search",
    description: "Web search using Brave Search API",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-brave-search"],
    envHint: "BRAVE_API_KEY",
  },
  {
    name: "puppeteer",
    description: "Browser automation, web scraping, and screenshot capture",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-puppeteer"],
  },
  {
    name: "playwright",
    description: "Browser automation and testing with Playwright",
    command: "npx",
    args: ["-y", "@anthropic/playwright-mcp"],
  },

  // ── Cloud ──────────────────────────────────────────────────────────
  {
    name: "aws-kb-retrieval",
    description: "AWS Bedrock knowledge base retrieval",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-aws-kb-retrieval"],
    envHint: "AWS_ACCESS_KEY_ID",
  },
  {
    name: "cloudflare",
    description: "Cloudflare Workers and resource management",
    command: "npx",
    args: ["-y", "@anthropic/cloudflare-mcp"],
    envHint: "CLOUDFLARE_API_TOKEN",
  },

  // ── Communication ──────────────────────────────────────────────────
  {
    name: "slack",
    description: "Slack workspace — channel management, messaging, search",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-slack"],
    envHint: "SLACK_BOT_TOKEN",
  },
  {
    name: "notion",
    description: "Notion workspace — pages, databases, search, and content management",
    command: "npx",
    args: ["-y", "@anthropic/notion-mcp"],
    envHint: "NOTION_API_KEY",
  },

  // ── Files & Documents ──────────────────────────────────────────────
  {
    name: "google-drive",
    description: "Google Drive file access, search, and content retrieval",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-google-drive"],
    envHint: "GOOGLE_APPLICATION_CREDENTIALS",
  },
  {
    name: "google-maps",
    description: "Google Maps location data, directions, and geocoding",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-google-maps"],
    envHint: "GOOGLE_MAPS_API_KEY",
  },

  // ── AI & Image ─────────────────────────────────────────────────────
  {
    name: "everart",
    description: "AI image generation using various models",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-everart"],
    envHint: "EVERART_API_KEY",
  },

  // ── Productivity ───────────────────────────────────────────────────
  {
    name: "todoist",
    description: "Todoist task management — create, update, complete tasks and projects",
    command: "npx",
    args: ["-y", "@anthropic/todoist-mcp"],
    envHint: "TODOIST_API_TOKEN",
  },
  {
    name: "jira",
    description: "Jira issue tracking — search, create, and update issues",
    command: "npx",
    args: ["-y", "@anthropic/jira-mcp"],
    envHint: "JIRA_API_TOKEN",
  },

  // ── Data & Analytics ───────────────────────────────────────────────
  {
    name: "bigquery",
    description: "Google BigQuery — query datasets and manage tables",
    command: "npx",
    args: ["-y", "@anthropic/bigquery-mcp"],
    envHint: "GOOGLE_APPLICATION_CREDENTIALS",
  },
  {
    name: "snowflake",
    description: "Snowflake data warehouse — run queries and manage data",
    command: "npx",
    args: ["-y", "@anthropic/snowflake-mcp"],
    envHint: "SNOWFLAKE_ACCOUNT",
  },
  {
    name: "elasticsearch",
    description: "Elasticsearch — search, index, and analyze data",
    command: "npx",
    args: ["-y", "@anthropic/elasticsearch-mcp"],
    envHint: "ELASTICSEARCH_URL",
  },

  // ── CMS & Commerce ─────────────────────────────────────────────────
  {
    name: "stripe",
    description: "Stripe payment processing — customers, charges, subscriptions",
    command: "npx",
    args: ["-y", "@anthropic/stripe-mcp"],
    envHint: "STRIPE_SECRET_KEY",
  },
  {
    name: "shopify",
    description: "Shopify e-commerce — products, orders, customers",
    command: "npx",
    args: ["-y", "@anthropic/shopify-mcp"],
    envHint: "SHOPIFY_ACCESS_TOKEN",
  },

  // ── Monitoring ─────────────────────────────────────────────────────
  {
    name: "datadog",
    description: "Datadog monitoring — metrics, logs, and dashboards",
    command: "npx",
    args: ["-y", "@anthropic/datadog-mcp"],
    envHint: "DD_API_KEY",
  },
  {
    name: "pagerduty",
    description: "PagerDuty incident management — alerts and escalations",
    command: "npx",
    args: ["-y", "@anthropic/pagerduty-mcp"],
    envHint: "PAGERDUTY_API_KEY",
  },
];

export function getCatalogEntry(name: string): McpCatalogEntry | undefined {
  return MCP_CATALOG.find(e => e.name === name);
}

export function getCatalogText(): string {
  return MCP_CATALOG
    .map(e => `- ${e.name}: ${e.description}${e.envHint ? ` [requires ${e.envHint}]` : ""}`)
    .join("\n");
}
