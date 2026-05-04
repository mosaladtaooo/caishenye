/**
 * POST /api/internal/telegram/send — proxy to Telegram Bot API sendMessage.
 *
 * Body: { chat_id?, text, tenantId? }
 *   - tenantId defaults to 1.
 *   - chat_id is OPTIONAL (session 5g change). If absent, falls back to
 *     the FIRST entry in tenants.allowed_telegram_user_ids — the canonical
 *     "operator's chat" the Routine should reach for digest/alert messages.
 *
 * Validates chat_id is in tenants.allowed_telegram_user_ids — defence
 * against compromised Routine spamming arbitrary chat IDs (clarify Q1 /
 * AC-004-6). The fallback path inherits this guarantee for free since the
 * fallback value is drawn from the allowlist itself.
 *
 * Session 5g — chat_id became optional after live wire-up showed the
 * Planner/Executor system prompts have no clean way to learn the operator's
 * chat ID without it being smuggled in via env (which would either leak
 * via /fire payload logs or require a new INTERNAL_API_TOKEN-equivalent
 * per-tenant secret in Cloud Env). The allowlist[0] fallback keeps the
 * Routine prompt stateless re: chat IDs.
 *
 * Operator override: if `OPERATOR_CHAT_ID` env is set on the Vercel side,
 * it takes precedence over allowlist[0]. Optional convenience for ops who
 * keep multiple allowlisted users but want a specific one to receive the
 * default digest. Untyped/non-numeric values are ignored (logs the issue
 * via stderr but still falls through to allowlist[0]).
 */

import { getTenantDb } from '@caishen/db/client';
import { tenants } from '@caishen/db/schema/tenants';
import { sendTelegramMessage } from '@caishen/routines/telegram-bot';
import { eq } from 'drizzle-orm';
import { validateInternalAuth } from '@/lib/internal-auth';
import { jsonRes } from '@/lib/internal-route-helpers';

interface SendBody {
  /** Optional — if absent, OPERATOR_CHAT_ID env wins, else allowlist[0]. */
  chat_id?: number;
  text: string;
  tenantId: number;
}

function validateBody(raw: unknown): SendBody | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.text !== 'string' || r.text.length === 0) return null;
  const tenantId = typeof r.tenantId === 'number' ? r.tenantId : 1;
  const out: SendBody = { text: r.text, tenantId };
  if (typeof r.chat_id === 'number') out.chat_id = r.chat_id;
  return out;
}

function readOperatorChatIdEnv(): number | null {
  const raw = process.env.OPERATOR_CHAT_ID ?? '';
  if (raw.length === 0) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    process.stderr.write(
      `telegram/send: OPERATOR_CHAT_ID env present but not a positive number; ignoring\n`,
    );
    return null;
  }
  return n;
}

export async function POST(req: Request): Promise<Response> {
  const authFail = validateInternalAuth(req);
  if (authFail) return authFail;

  const botToken = process.env.TELEGRAM_BOT_TOKEN ?? '';
  if (botToken.length === 0) {
    return jsonRes(500, {
      error: 'telegram/send: server misconfigured (TELEGRAM_BOT_TOKEN missing)',
    });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return jsonRes(400, { error: 'invalid JSON body' });
  }

  const body = validateBody(raw);
  if (!body) {
    return jsonRes(400, {
      error: 'invalid body: require { text: string }; chat_id and tenantId optional',
    });
  }

  // Allowlist lookup happens regardless of supplied chat_id — both gates
  // (provided or fallback) MUST be in the allowlist.
  let allowedIds: readonly number[];
  try {
    const tenantDb = getTenantDb(body.tenantId);
    const rows = await tenantDb.drizzle
      .select({ allowed: tenants.allowedTelegramUserIds })
      .from(tenants)
      .where(eq(tenants.id, body.tenantId));
    allowedIds = (rows[0]?.allowed as readonly number[] | null) ?? [];
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return jsonRes(500, { error: `telegram/send: tenant lookup failed: ${msg.slice(0, 256)}` });
  }

  // Resolve target chat_id.
  let targetChatId: number | undefined = body.chat_id;
  if (targetChatId === undefined) {
    const envOverride = readOperatorChatIdEnv();
    if (envOverride !== null && allowedIds.includes(envOverride)) {
      targetChatId = envOverride;
    } else if (allowedIds.length > 0) {
      targetChatId = allowedIds[0];
    } else {
      return jsonRes(503, {
        error:
          'telegram/send: no chat_id given and tenant allowlist is empty — operator must set tenants.allowed_telegram_user_ids',
      });
    }
  }

  if (!allowedIds.includes(targetChatId)) {
    return jsonRes(403, {
      error: `telegram/send: chat_id ${targetChatId} not in tenant ${body.tenantId} allowlist`,
    });
  }

  // Forward to the Bot API via the routines/telegram-bot helper.
  try {
    const result = await sendTelegramMessage(
      { chatId: targetChatId, text: body.text },
      {
        fetch,
        botToken,
        sleep: (ms: number) =>
          new Promise<void>((r) => {
            setTimeout(r, ms);
          }),
      },
    );
    return jsonRes(200, { ok: true, telegramMessageId: result.message_id, chatId: targetChatId });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return jsonRes(502, { error: `telegram/send: ${msg.slice(0, 256)}` });
  }
}
