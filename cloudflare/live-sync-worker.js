import { DurableObject } from "cloudflare:workers";
import {
  FAST_POLL_INTERVAL_MS,
  pollSlackStatuses,
  syncLiveState,
} from "../backend/live-sync.js";
import {
  evaluateCoverageAlert,
  sendSlackAlertTest,
  validateSlackAlertChannel,
} from "../backend/coverage-alerts.js";

const POLLER_NAME = "live-support-status";

function json(body, status = 200) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function safeSecretMatch(received, expected) {
  if (!received || !expected) return false;
  const encoder = new TextEncoder();
  const left = encoder.encode(received);
  const right = encoder.encode(expected);
  if (left.byteLength !== right.byteLength) return false;
  return crypto.subtle.timingSafeEqual(left, right);
}

function getPollerStub(env) {
  if (!env.STATUS_POLLER) throw new Error("Durable Object binding STATUS_POLLER is missing");
  return env.STATUS_POLLER.getByName(POLLER_NAME);
}

async function startStatusPoller(env) {
  const response = await getPollerStub(env).fetch("https://status-poller/start", {
    method: "POST",
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "The 15-second poller could not start");
  return result;
}

async function readStatusPoller(env) {
  const response = await getPollerStub(env).fetch("https://status-poller/status");
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "The poller status could not be read");
  return result;
}

async function handleHealth(env) {
  if (!env.DB) return json({ ok: false, error: "D1 binding missing" }, 503);
  try {
    const [state, coverageAlert, poller] = await Promise.all([
      env.DB.prepare("SELECT * FROM sync_state WHERE id = 1").first(),
      env.DB.prepare("SELECT * FROM coverage_alert_state WHERE id = 1").first(),
      readStatusPoller(env),
    ]);
    return json({ ok: true, state, coverageAlert, poller });
  } catch (error) {
    return json({ ok: false, error: error.message }, 503);
  }
}

export class StatusPoller extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/start") {
      let nextAlarm = await this.ctx.storage.getAlarm();
      if (nextAlarm === null) {
        nextAlarm = Date.now() + FAST_POLL_INTERVAL_MS;
        await this.ctx.storage.setAlarm(nextAlarm);
      }
      return json({
        running: true,
        nextAlarm,
        intervalMs: FAST_POLL_INTERVAL_MS,
      });
    }

    if (request.method === "GET" && url.pathname === "/status") {
      const [nextAlarm, lastPollAt, lastResult, lastError] = await Promise.all([
        this.ctx.storage.getAlarm(),
        this.ctx.storage.get("lastPollAt"),
        this.ctx.storage.get("lastResult"),
        this.ctx.storage.get("lastError"),
      ]);
      return json({
        running: nextAlarm !== null || Boolean(lastPollAt),
        nextAlarm,
        lastPollAt: lastPollAt || null,
        intervalMs: lastResult?.nextPollInMs || FAST_POLL_INTERVAL_MS,
        lastResult: lastResult || null,
        lastError: lastError || null,
      });
    }

    return json({ error: "Not found" }, 404);
  }

  async alarm() {
    let nextPollInMs = FAST_POLL_INTERVAL_MS;
    try {
      const result = await pollSlackStatuses(this.env);
      nextPollInMs = result.nextPollInMs;
      result.coverageAlert = await evaluateCoverageAlert(this.env, result);
      await this.ctx.storage.put({
        lastPollAt: Date.now(),
        lastResult: result,
        lastError: null,
      });
      console.log("Fast Slack poll complete", result);
    } catch (error) {
      await this.ctx.storage.put({
        lastPollAt: Date.now(),
        lastError: error.message,
      });
      console.error("Fast Slack poll failed", error);
    } finally {
      await this.ctx.storage.setAlarm(Date.now() + nextPollInMs);
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return handleHealth(env);
    }

    const protectedRoutes = ["/sync", "/poller/start", "/alerts/validate", "/alerts/test"];
    if (request.method === "POST" && protectedRoutes.includes(url.pathname)) {
      const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
      if (!safeSecretMatch(bearer, env.SYNC_SECRET)) return json({ error: "Unauthorized" }, 401);

      try {
        if (url.pathname === "/alerts/validate") {
          return json(await validateSlackAlertChannel(env));
        }
        if (url.pathname === "/alerts/test") {
          return json(await sendSlackAlertTest(env));
        }
        if (url.pathname === "/poller/start") return json(await startStatusPoller(env));
        const result = await syncLiveState(env);
        const poller = await startStatusPoller(env);
        return json({ ...result, poller });
      } catch (error) {
        return json({ ok: false, error: error.message }, 500);
      }
    }

    return json({ error: "Not found" }, 404);
  },

  async scheduled(controller, env, context) {
    context.waitUntil(Promise.all([
      syncLiveState(env, controller.scheduledTime)
        .then((result) => console.log("Minute reconciliation complete", result))
        .catch((error) => console.error("Minute reconciliation failed", error)),
      startStatusPoller(env)
        .then((result) => console.log("Fast poller confirmed", result))
        .catch((error) => console.error("Fast poller start failed", error)),
    ]));
  },
};
