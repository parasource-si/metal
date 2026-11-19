import type { DirectoryApp } from "../../shared/connector-directory.ts";
import type { ConnectorProvider } from "./provider.ts";

type Row = [id: string, label: string, url: string, domain: string, category: string, description: string];

// vendors' own hosted MCP servers. "oauth" rows sign in with the person's own account and no app registered per vendor:
// the server's authorization server registers clients dynamically, or takes Metal's client id metadata document
// (shared/mcp-client-metadata.ts; railway, mongodb). scripts/probe-remote-mcp.ts checks every row live: discovery,
// registration, an authorize page that loads and a refused fake token. Last run 2026-11-13, all passing.
// left out on purpose: no dynamic registration and no metadata document (github, hubspot, slack, box, xero, docusign,
// asana v2, render, pagerduty, smartsheet, calendly, gamma), refuses unreviewed clients (figma, dropbox: dropbox signs in
// through Metal's own app instead, shared/native-connectors.json), or no OAuth at all (similarweb).
const OAUTH: readonly Row[] = [
  ["linear", "Linear", "https://mcp.linear.app/mcp", "linear.app", "project management", "Issues, projects and cycles in Linear"],
  ["notion", "Notion", "https://mcp.notion.com/mcp", "notion.so", "documents notes", "Search, read and write pages and databases"],
  ["atlassian", "Atlassian", "https://mcp.atlassian.com/v2/mcp", "atlassian.com", "project management", "Jira issues and Confluence pages"],
  ["sentry", "Sentry", "https://mcp.sentry.dev/mcp", "sentry.io", "developer monitoring", "Errors, issues and releases from Sentry"],
  ["stripe", "Stripe", "https://mcp.stripe.com", "stripe.com", "payments", "Customers, payments, invoices and refunds"],
  ["cloudflare", "Cloudflare", "https://bindings.mcp.cloudflare.com/mcp", "cloudflare.com", "developer cloud", "Workers, KV, R2 and D1 in your account"],
  ["paypal", "PayPal", "https://mcp.paypal.com/mcp", "paypal.com", "payments", "Invoices, orders, refunds and disputes"],
  ["intercom", "Intercom", "https://mcp.intercom.com/mcp", "intercom.com", "customer support", "Conversations, contacts and help articles"],
  ["supabase", "Supabase", "https://mcp.supabase.com/mcp", "supabase.com", "developer database", "Projects, tables, SQL and edge functions"],
  ["neon", "Neon", "https://mcp.neon.tech/mcp", "neon.tech", "developer database", "Serverless Postgres projects, branches and queries"],
  ["canva", "Canva", "https://mcp.canva.com/mcp", "canva.com", "design", "Find, create and export Canva designs"],
  ["webflow", "Webflow", "https://mcp.webflow.com/mcp", "webflow.com", "design", "Sites, pages and CMS collections"],
  ["wix", "Wix", "https://mcp.wix.com/mcp", "wix.com", "design", "Sites, stores and bookings on Wix"],
  ["monday", "monday.com", "https://mcp.monday.com/mcp", "monday.com", "project management", "Boards, items and updates"],
  ["jam", "Jam", "https://mcp.jam.dev/mcp", "jam.dev", "developer", "Bug reports with logs and network requests"],
  ["netlify", "Netlify", "https://netlify-mcp.netlify.app/mcp", "netlify.com", "developer hosting", "Sites, deploys and environment settings"],
  ["prisma", "Prisma", "https://mcp.prisma.io/mcp", "prisma.io", "developer database", "Prisma Postgres databases and migrations"],
  ["airtable", "Airtable", "https://mcp.airtable.com/mcp", "airtable.com", "database", "Bases, tables and records"],
  ["zapier", "Zapier", "https://mcp.zapier.com/api/mcp/mcp", "zapier.com", "automation", "Thousands of apps through your Zapier account"],
  ["clickup", "ClickUp", "https://mcp.clickup.com/mcp", "clickup.com", "project management", "Tasks, lists and docs"],
  ["granola", "Granola", "https://mcp.granola.ai/mcp", "granola.ai", "meeting notes", "Your meeting notes and transcripts"],
  ["close", "Close", "https://mcp.close.com/mcp", "close.com", "crm", "Leads, contacts and deals"],
  ["attio", "Attio", "https://mcp.attio.com/mcp", "attio.com", "crm", "Records, lists and notes in your CRM"],
  ["miro", "Miro", "https://mcp.miro.com/", "miro.com", "whiteboard design", "Boards, sticky notes and diagrams"],
  ["posthog", "PostHog", "https://mcp.posthog.com/mcp", "posthog.com", "analytics", "Insights, feature flags and events"],
  ["amplitude", "Amplitude", "https://mcp.amplitude.com/mcp", "amplitude.com", "analytics", "Charts, cohorts and experiments"],
  ["cal", "Cal.com", "https://mcp.cal.com/mcp", "cal.com", "scheduling", "Bookings, event types and availability"],
  ["gitlab", "GitLab", "https://gitlab.com/api/v4/mcp", "gitlab.com", "developer code", "Projects, issues and merge requests"],
  ["krisp", "Krisp", "https://mcp.krisp.ai/mcp", "krisp.ai", "meeting notes", "Meeting notes and action items"],
  ["fireflies", "Fireflies", "https://mcp.fireflies.ai/mcp", "fireflies.ai", "meeting notes", "Meeting transcripts and summaries"],
  ["apify", "Apify", "https://mcp.apify.com", "apify.com", "data scraping", "Run scrapers and read their results"],
  ["grafana", "Grafana", "https://mcp.grafana.com/mcp", "grafana.com", "developer monitoring", "Dashboards, metrics and alerts"],
  ["honeycomb", "Honeycomb", "https://mcp.honeycomb.io/mcp", "honeycomb.io", "developer monitoring", "Traces, queries and SLOs"],
  ["buildkite", "Buildkite", "https://mcp.buildkite.com/mcp", "buildkite.com", "developer", "Pipelines, builds and jobs"],
  ["railway", "Railway", "https://mcp.railway.com/mcp", "railway.com", "developer hosting", "Projects, services and deploys"],
  ["mercury", "Mercury", "https://mcp.mercury.com/mcp", "mercury.com", "banking", "Accounts, balances and transactions"],
  ["ramp", "Ramp", "https://mcp.ramp.com/mcp", "ramp.com", "finance", "Cards, spend and reimbursements"],
  ["todoist", "Todoist", "https://ai.todoist.net/mcp", "todoist.com", "productivity task", "Tasks, projects and due dates"],
  ["fastmail", "Fastmail", "https://api.fastmail.com/mcp", "fastmail.com", "email calendar", "Mail, calendars and contacts in Fastmail"],
  ["asana", "Asana", "https://mcp.asana.com/mcp", "asana.com", "project management", "Tasks, projects and goals in Asana"],
  ["square", "Square", "https://mcp.squareup.com/mcp", "squareup.com", "payments", "Payments, orders, customers and catalog"],
  ["plaid", "Plaid", "https://api.dashboard.plaid.com/mcp", "plaid.com", "developer finance", "Your Plaid integration's items, usage and logs"],
  ["vercel", "Vercel", "https://mcp.vercel.com", "vercel.com", "developer hosting", "Projects, deployments and logs"],
  ["mongodb", "MongoDB Atlas", "https://mcp.mongodb.com/mcp", "mongodb.com", "developer database", "Atlas clusters, databases and queries"],
  ["klaviyo", "Klaviyo", "https://mcp.klaviyo.com/mcp", "klaviyo.com", "marketing email", "Campaigns, flows, lists and profiles"],
  ["postman", "Postman", "https://mcp.postman.com/mcp", "postman.com", "developer", "Workspaces, collections and APIs"],
  ["sanity", "Sanity", "https://mcp.sanity.io", "sanity.io", "content cms", "Documents, schemas and releases in Sanity"],
  ["contentful", "Contentful", "https://mcp.contentful.com/mcp", "contentful.com", "content cms", "Entries, assets and content types"],
  ["wordpress", "WordPress.com", "https://public-api.wordpress.com/wpcom/v2/mcp/v1", "wordpress.com", "content blog", "Posts, pages and site stats on WordPress.com"],
  ["jotform", "Jotform", "https://mcp.jotform.com/mcp", "jotform.com", "forms", "Forms and their submissions"],
  ["otter", "Otter", "https://mcp.otter.ai/mcp", "otter.ai", "meeting notes", "Meeting transcripts and summaries from Otter"],
  ["tldv", "tl;dv", "https://mcp.tldv.io/mcp", "tldv.io", "meeting notes", "Meeting recordings, notes and highlights"],
  ["semrush", "Semrush", "https://mcp.semrush.com/v1/mcp", "semrush.com", "marketing seo", "Keyword, backlink and traffic data"],
  ["helpscout", "Help Scout", "https://mcp.helpscout.net/mcp", "helpscout.com", "customer support", "Conversations, customers and docs"],
  ["plain", "Plain", "https://mcp.plain.com/mcp", "plain.com", "customer support", "Support threads and customers"],
  ["launchdarkly", "LaunchDarkly", "https://mcp.launchdarkly.com/mcp", "launchdarkly.com", "developer", "Feature flags, segments and experiments"],
  ["axiom", "Axiom", "https://mcp.axiom.co/mcp", "axiom.co", "developer monitoring", "Logs, traces and queries"],
  ["betterstack", "Better Stack", "https://mcp.betterstack.com", "betterstack.com", "developer monitoring", "Uptime monitors, incidents and logs"],
  ["upstash", "Upstash", "https://mcp.upstash.com/mcp", "upstash.com", "developer database", "Redis, QStash and vector databases"],
  ["clerk", "Clerk", "https://mcp.clerk.com/mcp", "clerk.com", "developer", "Users, organizations and sessions in Clerk"],
  ["tavily", "Tavily", "https://mcp.tavily.com/mcp", "tavily.com", "search", "Web search and extraction for agents"],
  ["dodopayments", "Dodo Payments", "https://mcp.dodopayments.com/mcp", "dodopayments.com", "payments", "Payments, subscriptions and customers"],
  ["morningstar", "Morningstar", "https://mcp.morningstar.com/mcp", "morningstar.com", "finance research", "Fund, stock and market research"],
];

// answer without a sign-in
const OPEN: readonly Row[] = [
  ["huggingface", "Hugging Face", "https://huggingface.co/mcp", "huggingface.co", "research", "Models, datasets, Spaces and papers"],
  ["exa", "Exa", "https://mcp.exa.ai/mcp", "exa.ai", "search", "Web search and page contents for agents"],
  ["context7", "Context7", "https://mcp.context7.com/mcp", "context7.com", "developer", "Current docs for any library"],
  ["deepwiki", "DeepWiki", "https://mcp.deepwiki.com/mcp", "deepwiki.com", "developer research", "Ask about any public GitHub repository"],
  ["microsoftlearn", "Microsoft Learn", "https://learn.microsoft.com/api/mcp", "learn.microsoft.com", "developer research", "Search Microsoft's official docs and code samples"],
  ["cloudflaredocs", "Cloudflare Docs", "https://docs.mcp.cloudflare.com/mcp", "developers.cloudflare.com", "developer", "Search Cloudflare's developer docs"],
];

const app = (auth: "oauth" | "none") => ([id, label, url, domain, category, description]: Row): DirectoryApp => ({
  id, source: "remote-mcp", label, description, categories: [category], domain, logo: null, url, auth,
});

export const REMOTE_MCP_APPS: readonly DirectoryApp[] = [...OAUTH.map(app("oauth")), ...OPEN.map(app("none"))];

/** The vendors' own MCP servers: always available, nothing to set up, each signs in with the person's own account. */
export const remoteMcpProvider: ConnectorProvider = {
  id: "remote-mcp",
  available: () => true,
  catalog: async () => [...REMOTE_MCP_APPS],
};
