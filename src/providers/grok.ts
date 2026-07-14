import { existsSync, readFileSync } from "node:fs";
import type { ProviderSnapshot } from "../types.js";
import { availableInFromEpoch, fetchJson, home, isoFromEpochSec } from "../util.js";
import { detectGrok } from "./detect.js";

interface GrokAuthEntry {
  key?: string;
  email?: string;
  expires_at?: string;
  auth_mode?: string;
  refresh_token?: string;
  first_name?: string;
}

function readGrokAuth(): GrokAuthEntry | null {
  const path = home(".grok", "auth.json");
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, GrokAuthEntry>;
    const entries = Object.values(raw);
    return entries[0] || null;
  } catch {
    return null;
  }
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const part = token.split(".")[1];
    if (!part) return null;
    const padded = part + "=".repeat((4 - (part.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

export async function collectGrok(): Promise<ProviderSnapshot> {
  const bin = detectGrok();
  const base: ProviderSnapshot = {
    id: "grok",
    displayName: "Grok",
    installed: bin.installed,
    binary: bin.path,
    version: bin.version,
    auth: "missing",
    plan: null,
    account: null,
    windows: [],
    source: "none",
    error: null,
    hint: null,
    score: null,
  };

  if (!bin.installed) {
    base.hint = "Install Grok Build CLI, then `grok login`.";
    return base;
  }

  const auth = readGrokAuth();
  if (!auth?.key) {
    base.hint = "Run `grok login`.";
    return base;
  }

  base.account = auth.email || null;
  const claims = decodeJwtPayload(auth.key);
  const exp = typeof claims?.exp === "number" ? claims.exp : null;
  if (exp && exp * 1000 < Date.now()) {
    base.auth = "expired";
    base.hint = "Grok access token expired — run `grok login`.";
    return base;
  }

  base.auth = "ok";
  const tier = typeof claims?.tier === "number" ? claims.tier : null;
  base.plan = tier != null ? `tier ${tier}` : auth.auth_mode || "oidc";
  base.source = "local_auth+api_probe";

  // Probe API: consumer JWT often authenticates but SuperGrok weekly pool
  // is not exposed on a stable public endpoint (Cloudflare on grok.com/rest/*).
  const probe = await fetchJson("https://api.x.ai/v1/models", {
    headers: {
      Authorization: `Bearer ${auth.key}`,
      Accept: "application/json",
      "User-Agent": `GrokCLI/${bin.version || "0.2"}`,
    },
  });

  if (probe.status === 403) {
    const msg =
      (probe.json as { error?: string } | null)?.error ||
      probe.text.slice(0, 180);
    base.hint = `${msg} · weekly pool: Settings → Usage on grok.com`;
    // Treat as authenticated but quota unknown / likely exhausted for API path
    base.windows = [
      {
        name: "api_or_weekly",
        label: "API/credits",
        usedPercent: msg.toLowerCase().includes("run out") ? 100 : null,
        resetsAt: auth.expires_at || (exp ? isoFromEpochSec(exp) : null),
        availableIn: exp ? availableInFromEpoch(exp) : availableInFromIsoSafe(auth.expires_at),
        windowSeconds: null,
        detail: "SuperGrok weekly % not exposed to CLI yet",
      },
    ];
    base.score = base.windows[0]?.usedPercent ?? 100;
    return base;
  }

  if (probe.ok) {
    base.hint =
      "API auth OK. SuperGrok weekly pool still lives in Settings → Usage (no stable CLI endpoint yet).";
    base.windows = [
      {
        name: "weekly_pool",
        label: "weekly pool",
        usedPercent: null,
        resetsAt: null,
        availableIn: null,
        windowSeconds: 7 * 86400,
        detail: "open grok.com → Settings → Usage",
      },
    ];
    base.score = 50; // unknown — mid priority
    return base;
  }

  base.error = `API probe HTTP ${probe.status}`;
  base.hint = "Check `grok login` and grok.com → Settings → Usage.";
  return base;
}

function availableInFromIsoSafe(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const sec = Math.floor((t - Date.now()) / 1000);
  if (sec < 0) return "0m";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 48) return `${Math.floor(h / 24)}d${h % 24}h`;
  if (h > 0) return `${h}h${m}m`;
  return `${m}m`;
}
