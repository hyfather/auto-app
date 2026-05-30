export interface HarnessConfig {
  githubOwner?: string;
  githubRepo?: string;
  githubToken?: string;
  openaiApiKey?: string;
  anthropicApiKey?: string;
  baseBranch: string;
  modelPreference: "opus-4.8" | "codex-5.5" | "provider-default";
  vercelProjectUrl?: string;
  adminTokenConfigured: boolean;
}

export function getHarnessConfig(): HarnessConfig {
  return {
    githubOwner: process.env.GITHUB_OWNER,
    githubRepo: process.env.GITHUB_REPO,
    githubToken: process.env.GITHUB_TOKEN,
    openaiApiKey: process.env.OPENAI_API_KEY,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    baseBranch: process.env.AUTO_APP_BASE_BRANCH ?? "main",
    modelPreference: parseModelPreference(process.env.AUTO_APP_MODEL),
    vercelProjectUrl: process.env.VERCEL_PROJECT_PRODUCTION_URL,
    adminTokenConfigured: Boolean(process.env.AUTO_APP_ADMIN_TOKEN)
  };
}

function parseModelPreference(value: string | undefined): HarnessConfig["modelPreference"] {
  if (value === "opus-4.8" || value === "codex-5.5") {
    return value;
  }

  return "provider-default";
}
