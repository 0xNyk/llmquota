import {
  applyGrokBillingRecord,
  finalizeGrokProbeForTest,
  grokAuthIdentityForTest,
  grokAuthEntryIsOidcForTest,
  grokAuthPathForTest,
  grokHomePathForTest,
  grokMissingRefreshTokenErrorForTest,
  parseGrokBillingLogLine,
  parseGrokCreditsPayload,
} from "./providers/grok.js";
import { baseSnapshot } from "./snapshot.js";
import { availability } from "./tui-model.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
  console.log(`ok    ${msg}`);
}

function base() {
  return baseSnapshot({
    id: "grok",
    displayName: "Grok",
    installed: true,
    binary: "/tmp/grok",
    version: "0.1",
    auth: "ok",
  });
}

const billingLine = JSON.stringify({
  ts: "2026-07-14T16:10:28.586Z",
  msg: "billing: fetched credits config",
  ctx: {
    config: {
      creditUsagePercent: 100,
      currentPeriod: {
        type: "USAGE_PERIOD_TYPE_WEEKLY",
        start: "2026-07-13T02:47:16.234615+00:00",
        end: "2026-07-20T02:47:16.234615+00:00",
      },
      onDemandCap: { val: 0 },
      onDemandUsed: { val: 0 },
      prepaidBalance: { val: 0 },
    },
    onDemandEnabled: null,
    subscriptionTier: "SuperGrok Heavy",
  },
});

{
  assert(grokAuthPathForTest({ GROK_AUTH_JSON: "/tmp/custom-grok-auth.json" }) ===
    "/tmp/custom-grok-auth.json", "Grok auth path honors GROK_AUTH_JSON");
  assert(grokAuthPathForTest({ GROK_HOME: "/tmp/custom-grok-home" }) ===
    "/tmp/custom-grok-home/auth.json", "Grok auth path honors GROK_HOME");
  assert(grokHomePathForTest({ GROK_AUTH_JSON: "/tmp/custom-grok-auth.json" }) ===
    "/tmp", "Grok auth file directory controls fallback state without GROK_HOME");
  assert(grokHomePathForTest({
    GROK_AUTH_JSON: "/tmp/custom-grok-auth.json",
    GROK_HOME: "/tmp/custom-grok-home",
  }) === "/tmp/custom-grok-home", "GROK_HOME controls fallback state with an auth override");
  assert(grokAuthEntryIsOidcForTest("https://auth.x.ai::client", {
    auth_mode: "oidc",
    oidc_issuer: "https://auth.x.ai",
    key: "token",
  }), "Grok auth selector accepts the official OIDC scope");
  assert(grokAuthEntryIsOidcForTest("https://accounts.x.ai/sign-in", {
    auth_mode: "oidc",
    key: "token",
  }), "Grok auth selector accepts the legacy OIDC scope");
  assert(!grokAuthEntryIsOidcForTest("https://accounts.x.ai/sign-in", {
    auth_mode: "oidc",
    oidc_issuer: "https://evil.example",
    key: "token",
  }), "Grok legacy scope rejects a conflicting arbitrary issuer");
  assert(!grokAuthEntryIsOidcForTest("api.x.ai", {
    auth_mode: "api-key",
    key: "api-key",
  }), "Grok auth selector rejects API-key credentials");
  assert(!grokAuthEntryIsOidcForTest("https://evil.example::client", {
    auth_mode: "oidc",
    oidc_issuer: "https://evil.example",
    key: "token",
  }), "Grok auth selector rejects arbitrary OIDC issuers");
}

{
  const record = parseGrokCreditsPayload({
    config: {
      creditUsagePercent: 6,
      currentPeriod: {
        type: "USAGE_PERIOD_TYPE_WEEKLY",
        start: "2026-08-07T09:03:08.730577+00:00",
        end: "2026-08-14T09:03:08.730577+00:00",
      },
      productUsage: [
        { product: "GrokBuild", usagePercent: 5 },
        { product: "GrokChat", usagePercent: 1 },
      ],
      isUnifiedBillingUser: true,
      onDemandCap: { val: 0 },
      onDemandUsed: { val: 0 },
      prepaidBalance: { val: 0 },
    },
  }, Date.parse("2026-08-08T16:30:00Z"));
  assert(record?.usedPercent === 6 && record.productUsage?.length === 2,
    "Grok live credits payload yields shared weekly and product usage");
  const live = applyGrokBillingRecord(base(), record!, Date.parse("2026-08-08T16:30:00Z"), "api");
  assert(live.score === 6 && live.requestAvailability === "available",
    "Grok live credits payload proves current shared headroom");
  assert(live.source.includes("grok_billing_api"),
    "Grok live credits payload records its authoritative API source");
  assert(live.windows.some((window) => window.name === "product_grokbuild" && window.usedPercent === 5),
    "Grok Build product usage remains visible below the shared weekly pool");
  assert(live.windows.some((window) => window.name === "product_grokchat" && window.usedPercent === 1),
    "Grok Chat product usage remains visible below the shared weekly pool");
  const enumLive = applyGrokBillingRecord(base(), {
    ...record!,
    productUsage: [{ product: "PRODUCT_GROK_BUILD", usedPercent: 5 }],
  }, Date.parse("2026-08-08T16:30:00Z"));
  assert(enumLive.windows.some((window) =>
    window.name === "product_grokbuild" && window.label === "Grok Build"),
  "Grok protobuf enum product names normalize to the same product meter");

  const freshZero = parseGrokCreditsPayload({
    config: {
      currentPeriod: {
        type: "USAGE_PERIOD_TYPE_WEEKLY",
        start: "2026-08-07T09:03:08.730577+00:00",
        end: "2026-08-14T09:03:08.730577+00:00",
      },
    },
  }, Date.parse("2026-08-08T16:30:00Z"));
  assert(freshZero?.usedPercent === 0,
    "Grok current weekly proto3 payload can prove omitted usage is zero");

  for (const invalidPercent of ["0", null]) {
    const invalid = parseGrokCreditsPayload({
      config: {
        creditUsagePercent: invalidPercent,
        currentPeriod: {
          type: "USAGE_PERIOD_TYPE_WEEKLY",
          start: "2026-08-07T09:03:08.730577+00:00",
          end: "2026-08-14T09:03:08.730577+00:00",
        },
      },
    }, Date.parse("2026-08-08T16:30:00Z"));
    assert(invalid == null, "Grok present malformed shared usage stays unknown");
  }

  const future = parseGrokCreditsPayload({
    config: {
      creditUsagePercent: 6,
      currentPeriod: {
        type: "USAGE_PERIOD_TYPE_WEEKLY",
        start: "2026-08-09T09:03:08.730577+00:00",
        end: "2026-08-16T09:03:08.730577+00:00",
      },
    },
  }, Date.parse("2026-08-08T16:30:00Z"));
  assert(future == null, "Grok future weekly period is not current usage evidence");

  const contradictory = parseGrokCreditsPayload({
    config: {
      currentPeriod: {
        type: "USAGE_PERIOD_TYPE_WEEKLY",
        start: "2026-08-07T09:03:08.730577+00:00",
        end: "2026-08-14T09:03:08.730577+00:00",
      },
      productUsage: [{ product: "GrokBuild", usagePercent: 5 }],
    },
  }, Date.parse("2026-08-08T16:30:00Z"));
  assert(contradictory == null,
    "Grok omitted shared percent with positive product usage stays unknown");

  const malformedProduct = parseGrokCreditsPayload({
    config: {
      currentPeriod: {
        type: "USAGE_PERIOD_TYPE_WEEKLY",
        start: "2026-08-07T09:03:08.730577+00:00",
        end: "2026-08-14T09:03:08.730577+00:00",
      },
      productUsage: [{ product: "GrokBuild", usagePercent: "5" }],
    },
  }, Date.parse("2026-08-08T16:30:00Z"));
  assert(malformedProduct == null,
    "Grok malformed product usage cannot turn omitted shared usage into zero");

  const stale = parseGrokCreditsPayload({
    config: {
      creditUsagePercent: 6,
      currentPeriod: {
        type: "USAGE_PERIOD_TYPE_WEEKLY",
        start: "2026-07-31T09:03:08.730577+00:00",
        end: "2026-08-07T09:03:08.730577+00:00",
      },
    },
  }, Date.parse("2026-08-08T16:30:00Z"));
  assert(stale == null, "Grok expired credits payload is not current usage evidence");
}

{
  const identity = grokAuthIdentityForTest("oidc", false);
  assert(identity.plan == null,
    "Grok authentication does not invent a product plan");
  assert(identity.subscription === "Grok · grok.com OAuth",
    "Grok OIDC is labelled as grok.com authentication");
}

{
  const record = parseGrokBillingLogLine(billingLine);
  assert(record?.usedPercent === 100 && record.subscriptionTier === "SuperGrok Heavy",
    "Grok authoritative weekly billing log parses without invented values");
  const snap = applyGrokBillingRecord(base(), record!, Date.parse("2026-07-14T18:10:28Z"));
  assert(snap.windows[0]?.usedPercent === 100 &&
    snap.windows[0]?.resetsAt?.startsWith("2026-07-20") === true,
    "Grok weekly percent and reset come from the provider-fetched record");
  assert(snap.requestAvailability === "blocked" && availability(snap, "2026-07-14T18:10:28Z") === "tired",
    "Grok recorded exhaustion remains blocking until its real weekly reset");
  assert(snap.subscription?.includes("SuperGrok Heavy") === true,
    "Grok subscription tier comes from the provider-fetched billing record");

  const stalePartial = applyGrokBillingRecord(base(), { ...record!, usedPercent: 94 },
    Date.parse("2026-07-14T18:10:28Z"));
  assert(stalePartial.score == null && stalePartial.requestAvailability === "unknown",
    "Grok stale partial usage stays visible without pretending to be current availability");

  const onDemand = applyGrokBillingRecord(base(), {
    ...record!,
    onDemandEnabled: true,
    onDemandCap: 20,
    onDemandUsed: 5,
  }, Date.parse("2026-07-14T18:10:28Z"));
  assert(onDemand.requestAvailability === "available" && onDemand.score == null,
    "Grok real on-demand headroom prevents a false weekly KO score");
}

{
  const snap = finalizeGrokProbeForTest(base(), {
    ok: true,
    status: 200,
    json: { data: [] },
    text: "ok",
  });
  assert(snap.score == null, "ok probe → score null (no fake %)");
  assert(snap.windows.length === 0, "ok probe → no invented meter rows");
  assert(availability(snap) === "unknown", "ok probe → weekly availability remains unknown");
  assert(Boolean(snap.hint), "ok probe → hint points to real usage UI");
  assert(!/no public API/i.test(snap.hint || "") && /billing/i.test(snap.hint || ""),
    "ok probe → billing fallback copy reflects the live endpoint");
}

assert(grokMissingRefreshTokenErrorForTest("/tmp/custom-grok/auth.json") ===
  "no refresh_token in /tmp/custom-grok/auth.json",
"Grok refresh error reports the selected credential path");

{
  const snap = finalizeGrokProbeForTest(base(), {
    ok: false,
    status: 403,
    json: { error: "You have run out of credits or need a Grok subscription. Add credits at https://" },
    text: "run out",
  });
  assert(snap.score == null, "API credits 403 → score null (not SuperGrok KO)");
  assert(snap.windows.length === 0, "API credits 403 → no invented meter rows");
  assert(availability(snap) === "unknown", "API credits empty → weekly availability remains unknown");
  assert(/api\.x\.ai credits/i.test(snap.hint || ""), "API credits → real hint");
}

{
  const snap = finalizeGrokProbeForTest(base(), {
    ok: false,
    status: 403,
    json: { error: "rate limit exceeded" },
    text: "rate limit",
  });
  assert(snap.score == null, "rate-limit 403 → no invented 100%");
  assert(snap.windows.length === 0, "rate-limit → no invented meter rows");
  assert(/limit signal|rate/i.test(snap.hint || ""), "rate-limit → hint only");
}

{
  const snap = finalizeGrokProbeForTest(base(), {
    ok: false,
    status: 403,
    json: { error: "forbidden" },
    text: "forbidden",
  });
  assert(snap.score == null, "vague 403 → no invented KO score");
  assert(snap.windows.length === 0, "vague 403 → no invented meter rows");
}

console.log("\nall grok probe tests passed");
