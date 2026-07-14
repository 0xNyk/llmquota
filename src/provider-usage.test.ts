import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { collectClaudeUsageWindows, isClaudeUsagePayload } from "./providers/claude.js";
import {
  codexBlockedLimits,
  codexRequestAvailability,
  codexUsageScore,
  collectCodexUsageWindows,
  isCodexUsagePayload,
} from "./providers/codex.js";
import {
  collectCursorUsageWindows,
  cursorUsageHint,
  cursorInstalled,
  cursorStateDbCandidates,
  isCursorUsagePayload,
  readCursorAuthFromCandidates,
} from "./providers/cursor.js";
import {
  buildHermesMeters,
  discoverNousSlotsWithFallback,
  hermesAvailabilityScore,
  hermesEntitlementHint,
  hermesGlobalAuthPath,
  hermesProviderAccessToken,
  hermesPaidAccessAllowed,
  hermesSubscriptionLabels,
  hermesUsageScore,
  isNousAccountPayload,
  mergeHermesAuthFallback,
} from "./providers/hermes.js";
import { pickFighter, primaryMeter } from "./collect.js";
import { renderRoster } from "./render.js";
import { baseSnapshot } from "./snapshot.js";
import { availability, soonestReset } from "./tui-model.js";
import { availabilityScore, fetchJson } from "./util.js";
import { meterSlot } from "./tui-card-body.js";
import {
  parseHermesModelConfig,
  parseCursorModelConfig,
  parseJsonModelConfig,
  parseTomlModelConfig,
  readCodexActiveSelection,
  readCursorActiveSelection,
  readGrokActiveSelection,
  readHermesActiveSelection,
} from "./active-selection.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
  console.log(`ok    ${msg}`);
}

{
  const hermes = parseHermesModelConfig(`
model:
  default: gpt-5.6-sol
  provider: openai-codex
providers: {}
`);
  assert(hermes.provider === "openai-codex" && hermes.model === "gpt-5.6-sol",
    "Hermes runtime provider and model parse from model config");
  const flatHermes = parseHermesModelConfig("model: z-ai/glm-4.7-flash\n");
  assert(flatHermes.model === "z-ai/glm-4.7-flash" && flatHermes.provider == null,
    "Hermes legacy flat model remains detectable without inventing provider");
  const envHermes = parseHermesModelConfig(
    "model:\n  default: ${HERMES_TEST_MODEL}\n  provider: ${HERMES_TEST_PROVIDER}\n",
    { HERMES_TEST_MODEL: "env-model", HERMES_TEST_PROVIDER: "env-provider" },
  );
  assert(envHermes.provider === "env-provider" && envHermes.model === "env-model",
    "Hermes environment-expanded runtime selection detected");
  const claude = parseJsonModelConfig('{"model":"sonnet"}', "Anthropic");
  assert(claude.provider === "Anthropic" && claude.model === "sonnet",
    "Claude configured model parses from settings JSON");
  const cursor = parseCursorModelConfig(JSON.stringify({
    model: { modelId: "fallback-model" },
    selectedModel: { modelId: "grok-4.5" },
  }));
  assert(cursor.provider === "Cursor" && cursor.model === "grok-4.5",
    "Cursor selected model parses from CLI config");
  const codex = parseTomlModelConfig('model = "gpt-5.5"\nmodel_provider = "openai"\n');
  assert(codex.provider === "openai" && codex.model === "gpt-5.5",
    "Codex configured provider and model parse from top-level TOML");
  const grok = parseTomlModelConfig('[models]\ndefault = "grok-build"\n', {
    section: "models",
    defaultProvider: "xAI",
  });
  assert(grok.provider === "xAI" && grok.model === "grok-build",
    "Grok configured new-session model parses from models table");

  const dir = mkdtempSync(join(tmpdir(), "llmquota-selection-"));
  try {
    writeFileSync(join(dir, "config.yaml"), "model:\n  default: hermes-model\n  provider: nous\n");
    const selectedHermes = readHermesActiveSelection(dir);
    assert(selectedHermes.provider === "nous" && selectedHermes.model === "hermes-model",
      "Hermes active selection reads its runtime config file");

    writeFileSync(join(dir, "config.toml"), 'model = "configured-codex"\n');
    const sessionDir = join(dir, "sessions", "2026", "07", "15");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, "rollout-test-thread.jsonl"),
      '{"type":"turn_context","payload":{"model":"active-codex"}}\n',
    );
    const selectedCodex = readCodexActiveSelection(dir, "test-thread");
    assert(selectedCodex.model === "active-codex",
      "Codex current-thread model overrides configured default");

    writeFileSync(join(dir, "cli-config.json"), '{"model":{"modelId":"cursor-live"}}');
    const selectedCursor = readCursorActiveSelection(dir);
    assert(selectedCursor.model === "cursor-live",
      "Cursor configured model reads from its CLI config file");

    writeFileSync(join(dir, "active_sessions.json"), '[{"model_id":"grok-live","provider":"xai"}]');
    const selectedGrok = readGrokActiveSelection(dir);
    assert(selectedGrok.provider === "xai" && selectedGrok.model === "grok-live",
      "Grok active session model overrides configured default");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const validators = [
    [isClaudeUsagePayload, { five_hour: null }],
    [isCodexUsagePayload, { rate_limit: null }],
    [isCursorUsagePayload, { planUsage: null }],
    [isNousAccountPayload, { paid_service_access: null }],
  ] as const;
  for (const [validate, recognizable] of validators) {
    assert(!validate({}), "empty successful provider payload rejected");
    assert(!validate({ ...recognizable, error: "upstream failure" }),
      "error-shaped successful provider payload rejected");
    assert(validate(recognizable), "known null provider field remains recognizable evidence");
  }
}

{
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => {
      throw new TypeError("fixture network failure");
    }) as typeof fetch;
    const failed = await fetchJson("https://example.invalid/usage");
    assert(!failed.ok && failed.status === 0 && failed.json == null,
      "provider network rejection becomes an isolated HTTP-0 result");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

{
  const now = Date.parse("2026-07-15T00:00:00Z");
  const windows = collectCodexUsageWindows({
    rate_limit: {
      primary_window: {
        used_percent: 16,
        limit_window_seconds: 604800,
        reset_after_seconds: 3600,
      },
    },
    additional_rate_limits: [{
      limit_name: "spark",
      rate_limit: {
        primary_window: { used_percent: 5, reset_at: 1784163600 },
        secondary_window: { used_percent: 9, reset_after_seconds: 7200 },
      },
    }],
    credits: { balance: "0", has_credits: false, unlimited: false },
    rate_limit_reset_credits: { available_count: 4 },
  }, now);
  assert(windows.find((w) => w.name === "primary")?.resetsAt === "2026-07-15T01:00:00.000Z",
    "Codex reset_after_seconds becomes a real absolute reset");
  assert(windows.some((w) => w.name === "spark_secondary" && w.usedPercent === 9),
    "Codex additional secondary windows detected");
  assert(windows.find((w) => w.name === "credits")?.detail === "balance 0 · none available",
    "Codex credit balance retained without invented currency");
  assert(/4 rate-limit resets available/.test(
    windows.find((w) => w.name === "reset_credits")?.detail || ""),
  "Codex rate-limit reset credits detected");
}

{
  const denied = {
    rate_limit: {
      allowed: false,
      limit_reached: false,
      primary_window: { used_percent: 17, limit_window_seconds: 604800 },
    },
    additional_rate_limits: [{
      limit_name: "model pool",
      rate_limit: {
        allowed: true,
        limit_reached: true,
        primary_window: { used_percent: 100 },
      },
    }],
    credits: { has_credits: false },
  };
  const windows = collectCodexUsageWindows(denied, Date.now(), "model-pool");
  assert(windows.find((w) => w.name === "primary")?.usedPercent === 17,
    "Codex denial does not rewrite measured utilization to a fake 100%");
  assert(codexBlockedLimits(denied).join(",") === "primary,model pool",
    "Codex explicit primary and model-pool blocking states detected");
  assert(codexUsageScore(denied, windows, "model pool") === 100,
    "Codex active-model denial drives provider availability independently of measured percent");
  const unrelatedWindows = collectCodexUsageWindows(denied, Date.now(), "gpt-5.6-sol");
  assert(unrelatedWindows.find((w) => w.name === "model pool")?.affectsAvailability === false,
    "Codex unrelated model pool remains visible without blocking the active model");
  assert(codexUsageScore(denied, unrelatedWindows, "gpt-5.6-sol") === 100,
    "Codex primary denial still blocks every model");
  const credits = windows.find((w) => w.name === "credits");
  assert(credits?.detail === "none available",
    "Codex explicit no-credit state retained without a supplied balance");
  assert(credits?.affectsAvailability === false,
    "Codex credit availability remains a nonblocking billing fact");
}

{
  const modelOnlyDenied = {
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: { used_percent: 17, limit_window_seconds: 604800 },
    },
    code_review_rate_limit: {
      allowed: false,
      primary_window: { used_percent: 100 },
    },
    additional_rate_limits: [{
      limit_name: "GPT-5.3-Codex-Spark",
      rate_limit: {
        allowed: false,
        limit_reached: true,
        primary_window: { used_percent: 100 },
      },
    }],
  };
  const current = collectCodexUsageWindows(modelOnlyDenied, Date.now(), "gpt-5.6-sol");
  assert(current.find((w) => w.name === "code_review")?.affectsAvailability === false,
    "Codex code-review quota remains visible without blocking normal inference");
  assert(codexUsageScore(modelOnlyDenied, current, "gpt-5.6-sol") === 17,
    "Codex unrelated exhausted model and code-review pools do not block the active model");
  assert(codexRequestAvailability(modelOnlyDenied, "gpt-5.6-sol", 17) === "available",
    "Codex explicit primary allowance proves the active model is available");
  const spark = collectCodexUsageWindows(modelOnlyDenied, Date.now(), "gpt-5.3-codex-spark");
  assert(codexUsageScore(modelOnlyDenied, spark, "gpt-5.3-codex-spark") === 100,
    "Codex matching exhausted model pool blocks the active model");
  assert(codexRequestAvailability(modelOnlyDenied, "gpt-5.3-codex-spark", 100) === "blocked",
    "Codex explicit matching model denial proves the active model is blocked");
}

{
  const windows = collectClaudeUsageWindows({
    five_hour: { utilization: 0.5, resets_at: "2026-07-15T12:00:00Z" },
    seven_day: { utilization: 42, resets_at: "2026-07-20T12:00:00Z" },
    spend: {
      used: { amount_minor: 53411, currency: "EUR", exponent: 2 },
      limit: { amount_minor: 55000, currency: "EUR", exponent: 2 },
      percent: 97,
      enabled: false,
      disabled_reason: "out_of_credits",
    },
    extra_usage: {
      utilization: 97.11090909090909,
      is_enabled: false,
      disabled_reason: "out_of_credits",
    },
    limits: [
      { kind: "session", group: "session", percent: 0.5, is_active: true },
      {
        kind: "weekly_scoped",
        group: "weekly",
        percent: 66,
        resets_at: "2026-07-20T12:00:00Z",
        is_active: true,
        scope: { model: { display_name: "Fable" } },
      },
      { kind: "inactive_pool", percent: 100, is_active: false },
    ],
  });
  assert(windows.find((w) => w.name === "five_hour")?.usedPercent === 0.5,
    "Claude utilization is already percentage points");
  assert(windows.find((w) => w.name === "seven_day")?.usedPercent === 42,
    "Claude weekly utilization preserved");
  const spend = windows.find((w) => w.name === "extra_usage");
  assert(spend?.usedPercent === 97.11090909090909,
    "Claude precise extra-usage utilization preferred");
  assert(/€534\.11.*€550\.00/.test(spend?.detail || ""),
    "Claude extra-usage money uses authoritative minor units");
  assert(/disabled \(out of credits\)/.test(spend?.detail || ""),
    "Claude extra-usage disabled reason retained");
  assert(spend?.affectsAvailability === false,
    "Claude extra-usage billing does not claim request blocking");
  assert(windows.some((w) => w.name === "weekly_scoped" && w.label === "Fable"),
    "Claude active dynamic scoped limits detected");
  assert(!windows.some((w) => w.name === "inactive_pool"),
    "Claude inactive dynamic limits omitted");
  assert(windows.filter((w) => w.name === "five_hour").length === 1,
    "Claude dynamic limits deduplicate legacy windows");
}

{
  const globalAuth = {
    providers: { nous: { access_token: "global-token" } },
    credential_pool: {
      nous: [{ id: "global", access_token: "global-pool-token" }],
    },
  };
  const fallback = mergeHermesAuthFallback(
    { providers: {}, credential_pool: { nous: [] } },
    globalAuth,
  );
  assert(fallback.providerFromGlobal, "Hermes profile inherits missing global provider state");
  assert(fallback.poolFromGlobal, "Hermes empty profile pool inherits global pool");
  assert(fallback.auth.providers?.nous?.access_token === "global-token",
    "Hermes global provider fallback retains source state");
  assert(fallback.auth.credential_pool?.nous?.[0]?.id === "global",
    "Hermes global pool fallback retains source entries");
  assert(
    hermesProviderAccessToken({
      providers: { "openai-codex": { tokens: { access_token: "nested-token" } } },
    }, "OpenAI Codex") === "nested-token",
    "Hermes active provider token resolves nested OAuth state across label variants",
  );
  assert(
    hermesProviderAccessToken({
      credential_pool: { "openai-codex": [{ access_token: "pool-token" }] },
    }, "openai-codex") === "pool-token",
    "Hermes active provider token falls back to its credential pool",
  );
  const inheritedSlots = discoverNousSlotsWithFallback(
    { providers: {}, credential_pool: { nous: [] } },
    globalAuth,
    "/tmp/hermes/profiles/work/auth.json",
    "/tmp/hermes/auth.json",
  );
  assert(inheritedSlots.length === 1 && inheritedSlots[0]?.authFilePath === "/tmp/hermes/auth.json",
    "Hermes inherited credential keeps global persistence ownership");

  const shadowed = mergeHermesAuthFallback(
    {
      providers: { nous: { access_token: "profile-token" } },
      credential_pool: {
        nous: [{ id: "profile", access_token: "profile-pool-token" }],
      },
    },
    globalAuth,
  );
  assert(!shadowed.providerFromGlobal && !shadowed.poolFromGlobal,
    "Hermes configured profile shadows global Nous credentials");
  assert(shadowed.auth.credential_pool?.nous?.[0]?.id === "profile",
    "Hermes profile pool wins per-provider");
  assert(
    hermesGlobalAuthPath("/tmp/hermes/profiles/work", "/var/unused") ===
      "/tmp/hermes/auth.json",
    "Hermes Docker-style profile resolves global auth root",
  );
  assert(hermesGlobalAuthPath("/tmp/custom-hermes", "/var/unused") == null,
    "Hermes arbitrary custom home does not inherit unrelated auth");
}

{
  const windows = buildHermesMeters({
    subscription: {
      monthly_credits: 20,
      credits_remaining: 0,
      current_period_end: "2026-08-01T00:00:00Z",
      rollover_credits: 2.25,
    },
    paid_service_access: {
      purchased_credits_remaining: 7.5,
      total_usable_credits: 7.5,
    },
  });
  assert(windows.find((w) => w.name === "subscription")?.usedPercent === 100,
    "Hermes exhausted subscription grant detected");
  assert(/\$2\.25 rollover/.test(windows.find((w) => w.name === "subscription")?.detail || ""),
    "Hermes rollover balance retained");
  assert(/\$7\.50 usable/.test(windows.find((w) => w.name === "topup")?.detail || ""),
    "Hermes top-up balance retained without fake percent");
  assert(hermesUsageScore(windows, 7.5) == null,
    "Hermes top-up availability prevents false KO score");
  assert(hermesUsageScore(windows, 0) === 100,
    "Hermes depleted account remains KO");

  const authoritative = {
    subscription: { monthly_credits: 20, credits_remaining: 15 },
    paid_service_access: { allowed: false, reason: "account_missing" },
  };
  assert(hermesPaidAccessAllowed(authoritative) === false,
    "Hermes preferred allowed entitlement field detected");
  assert(/account unavailable/i.test(hermesEntitlementHint(authoritative) || ""),
    "Hermes account-missing entitlement is not mislabeled credits depleted");
  const deniedWindows = buildHermesMeters(authoritative);
  assert(deniedWindows[0]?.usedPercent === 25,
    "Hermes denial does not rewrite measured subscription utilization");
  assert(hermesAvailabilityScore(authoritative, deniedWindows, null) === 100,
    "Hermes explicit paid-service denial drives provider availability");
  assert(
    hermesPaidAccessAllowed({ paid_service_access: { allowed: true, paid_access: false } }) === true,
    "Hermes allowed entitlement wins over legacy paid_access conflict",
  );

  const malformed = buildHermesMeters({
    subscription: { monthly_credits: Number.NaN, credits_remaining: 10 },
    paid_service_access: { total_usable_credits: Number.NaN },
  });
  assert(malformed.length === 0, "Hermes malformed monetary facts stay unknown");

  const accessFallback = buildHermesMeters({
    subscription: { monthly_credits: 20 },
    paid_service_access: {
      subscription_credits_remaining: 5,
      purchased_credits_remaining: 3,
      total_usable_credits: 8,
    },
  });
  assert(accessFallback.find((w) => w.name === "subscription")?.usedPercent === 75,
    "Hermes access entitlement fills missing subscription remainder");
  assert(/subscription \$5\.00.*purchased \$3\.00/.test(
    accessFallback.find((w) => w.name === "topup")?.detail || ""),
  "Hermes usable-credit components remain distinct");
  const labels = hermesSubscriptionLabels({
    paid_service_access: {
      allowed: true,
      subscription_tier: 2,
      subscription_monthly_charge: 20,
    },
  });
  assert(labels.plan === "tier 2" && labels.subscription === "Nous tier 2 · $20.00/mo",
    "Hermes entitlement tier and charge fill missing subscription object");
}

{
  const mac = cursorStateDbCandidates({
    platform: "darwin",
    env: {},
    homeDir: "/Users/test",
  });
  assert(mac[0] === "/Users/test/Library/Application Support/Cursor/User/globalStorage/state.vscdb",
    "Cursor macOS IDE state path detected");
  const linux = cursorStateDbCandidates({
    platform: "linux",
    env: { XDG_CONFIG_HOME: "/var/config" },
    homeDir: "/home/test",
  });
  assert(linux[0] === "/var/config/Cursor/User/globalStorage/state.vscdb",
    "Cursor Linux XDG state path detected");
  const windows = cursorStateDbCandidates({
    platform: "win32",
    env: { APPDATA: "C:\\Users\\test\\AppData\\Roaming" },
    homeDir: "C:\\Users\\test",
  });
  assert(windows[0] === "C:\\Users\\test\\AppData\\Roaming\\Cursor\\User\\globalStorage\\state.vscdb",
    "Cursor Windows APPDATA state path detected");
  const override = cursorStateDbCandidates({
    platform: "linux",
    env: { LLMQUOTA_CURSOR_STATE_DB: "/custom/cursor.vscdb" },
    homeDir: "/home/test",
  });
  assert(override[0] === "/custom/cursor.vscdb" && override.length === 1,
    "Cursor explicit state database override wins");

  const dir = mkdtempSync(join(tmpdir(), "llmquota-cursor-"));
  try {
    const malformed = join(dir, "state.vscdb");
    writeFileSync(malformed, "not sqlite");
    const auth = readCursorAuthFromCandidates([malformed]);
    assert(auth.dbPath === malformed && auth.error != null,
      "Cursor malformed local state is isolated without throwing");
    assert(cursorInstalled(false, auth), "Cursor IDE-only state counts as installed");

    const valid = join(dir, "valid.vscdb");
    const db = new DatabaseSync(valid);
    try {
      db.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)");
      const insert = db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)");
      insert.run("cursorAuth/accessToken", "fixture-token");
      insert.run("cursorAuth/cachedEmail", "cursor@example.test");
      insert.run("cursorAuth/stripeMembershipType", "pro");
      insert.run("cursorAuth/stripeSubscriptionStatus", "active");
    } finally {
      db.close();
    }
    const fallback = readCursorAuthFromCandidates([malformed, valid]);
    assert(fallback.dbPath === valid && fallback.error == null,
      "Cursor discovery skips an unreadable candidate when a valid state database follows");
    assert(fallback.accessToken === "fixture-token" && fallback.membership === "pro",
      "Cursor auth and subscription facts are read from IDE state");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const windows = collectCursorUsageWindows({
    billingCycleStart: "1783573607000",
    billingCycleEnd: "1786252007000",
    planUsage: {
      totalSpend: 108146,
      includedSpend: 40000,
      bonusSpend: 68146,
      limit: 40000,
      autoPercentUsed: 56.837,
      apiPercentUsed: 100,
      totalPercentUsed: 72.09733333333334,
    },
    autoBucketModels: ["grok-4.5", "composer-2"],
    spendLimitUsage: {
      totalSpend: 2451,
      individualLimit: 2000,
      individualUsed: 2451,
      limitType: "user",
    },
  }, "grok-4.5");
  const plan = windows.find((w) => w.name === "plan_total");
  assert(plan?.usedPercent === 72.09733333333334, "Cursor total pool percent preserved");
  assert(/\$1,081\.46 used.*\$400\.00 plan.*\$681\.46 bonus/.test(plan?.detail || ""),
    "Cursor plan, bonus, and consumed value stay distinct");
  assert(plan?.affectsAvailability === false,
    "Cursor aggregate spend remains visible without masquerading as the active pool");
  assert(windows.find((w) => w.name === "auto")?.affectsAvailability === true,
    "Cursor active model binds to its authoritative Auto bucket");
  assert(windows.find((w) => w.name === "api")?.affectsAvailability === false,
    "Cursor inactive named/API pool does not exhaust an Auto-bucket model");
  assert(availabilityScore(windows) === 56.837,
    "Cursor score follows the active model pool instead of the exhausted unrelated pool");
  const liveMessages = {
    autoBucketModels: ["grok-4.5"],
    displayMessage: "You've hit your usage limit",
    autoModelSelectedDisplayMessage: "You've used 57% of your included total usage",
    namedModelSelectedDisplayMessage: "You've used 100% of your included API usage",
  };
  assert(cursorUsageHint(liveMessages, "grok-4.5")?.includes("57%") === true,
    "Cursor hint follows the active Auto pool instead of a contradictory generic warning");
  assert(cursorUsageHint(liveMessages, "claude-fable-5")?.includes("100%") === true,
    "Cursor hint follows the named/API pool for a model outside Auto buckets");
  const billed = windows.find((w) => w.name === "on_demand");
  assert(Math.round(billed?.usedPercent || 0) === 123, "Cursor on-demand cap utilization derived");
  assert(/\$24\.51.*\$20\.00 user cap/.test(billed?.detail || ""),
    "Cursor on-demand spend and cap detected");
  assert(billed?.affectsAvailability === false,
    "Cursor on-demand billing does not claim request blocking");
}

{
  const p = baseSnapshot({
    id: "test",
    displayName: "Semantic test",
    installed: true,
    auth: "ok",
  });
  p.windows = [
    {
      name: "quota",
      label: "quota",
      usedPercent: 20,
      resetsAt: "2026-08-01T00:00:00Z",
      availableIn: "17d",
      windowSeconds: 7 * 86400,
    },
    {
      name: "billing",
      label: "billing",
      usedPercent: 100,
      resetsAt: "2026-07-16T00:00:00Z",
      availableIn: "1d",
      windowSeconds: 30 * 86400,
      detail: "$10.00 / $10.00 spent",
      affectsAvailability: false,
    },
  ];
  p.score = availabilityScore(p.windows);
  assert(p.score === 20, "billing-only utilization excluded from provider score");
  assert(availability(p) === "ready", "billing-only 100% does not create false KO");
  assert(primaryMeter(p)?.name === "quota", "primary meter prefers blocking quota");
  assert(
    meterSlot(p.windows[0]!, 40, 0).priority < meterSlot(p.windows[1]!, 40, 0).priority,
    "tight cards prioritize request quota over billing utilization",
  );
  assert(soonestReset(p)?.label === "quota", "back-in clock ignores billing-only reset");
  const rendered = renderRoster(
    {
      checkedAt: "2026-07-15T00:00:00Z",
      providers: [p],
      pick: { id: "test", line: "test" },
      pathNotes: [],
    },
    {
      json: false,
      plain: true,
      emoji: false,
      who: false,
      doctor: false,
      refresh: false,
    },
  );
  assert(rendered.includes("billing") && rendered.includes("$10.00 / $10.00 spent"),
    "billing-only meter remains visible in plain output");

  const billingOnly = baseSnapshot({
    id: "billing-only",
    displayName: "Billing only",
    installed: true,
    auth: "ok",
  });
  billingOnly.windows = [p.windows[1]!];
  billingOnly.score = availabilityScore(billingOnly.windows);
  assert(primaryMeter(billingOnly) == null,
    "billing-only account has no false primary quota meter");
}

{
  const unavailable = baseSnapshot({
    id: "offline",
    displayName: "Offline provider",
    installed: true,
    auth: "ok",
  });
  unavailable.error = "usage unavailable (network error)";
  assert(availability(unavailable) === "unknown",
    "authenticated provider with failed usage probe is unknown, not ready");
  const unavailablePick = pickFighter([unavailable]);
  assert(unavailablePick.id == null,
    "provider without current usage evidence is excluded from automatic pick");
  assert(unavailablePick.line.startsWith("usage unavailable"),
    "network-unknown roster is not mislabeled as rate-limit exhaustion");
}

{
  const claude = collectClaudeUsageWindows({
    five_hour: { utilization: Number.NaN },
    seven_day: { utilization: 25, resets_at: "definitely-not-a-date" },
    spend: { percent: -1 },
  });
  const cursor = collectCursorUsageWindows({
    billingCycleEnd: "2026-08-01 00:00:00",
    planUsage: { totalPercentUsed: Number.NaN, autoPercentUsed: -1 },
    spendLimitUsage: { individualUsed: 1, individualLimit: 2 },
  });
  const hermes = buildHermesMeters({
    subscription: {
      monthly_credits: 20,
      credits_remaining: 10,
      current_period_end: "tomorrow-ish",
    },
  });
  const codex = collectCodexUsageWindows({
    rate_limit: {
      primary_window: { used_percent: 10, reset_at: Number.MAX_VALUE },
    },
  });
  assert(claude.length === 1 && claude[0]?.resetsAt == null,
    "Claude malformed utilization is omitted and malformed reset stays unknown");
  assert(cursor.length === 1 && cursor[0]?.resetsAt == null,
    "Cursor malformed usage is omitted and malformed billing reset stays unknown");
  assert(hermes[0]?.resetsAt == null, "Hermes malformed subscription reset stays unknown");
  assert(codex[0]?.resetsAt == null, "Codex extreme reset epoch stays unknown without throwing");
}

console.log("\nall provider usage parser tests passed");
