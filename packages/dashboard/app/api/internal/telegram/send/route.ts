/**
 * POST /api/internal/telegram/send — proxy to Telegram Bot API sendMessage.
 *
 * Body: { chat_id, text, tenantId? } (tenantId defaults to 1).
 *
 * Validates chat_id is in tenants.allowed_telegram_user_ids — defence
 * against compromised Routine spamming arbitrary chat IDs (related to
 * clarify Q1 / AC-004-6).
 */

import { getTenantDb } from '@caishen/db/client';
import { tenants } from '@caishen/db/schema/tenants';
import { sendTelegramMessage } from '@caishen/routines/telegram-bot';
import { eq } from 'drizzle-orm';
import { validateInternalAuth } from '@/lib/internal-auth';
import { jsonRes } from '@/lib/internal-route-helpers';

interface SendBody {
  chat_id: number;
  text: string;
  tenantId: number;
}

function validateBody(raw: unknown): SendBody | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.chat_id !== 'number') return null;
  if (typeof r.text !== 'string' || r.text.length === 0) return null;
  const tenantId = typeof r.tenantId === 'number' ? r.tenantId : 1;
  return { chat_id: r.chat_id, text: r.text, tenantId };
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
    return jsonRes(400, { error: 'invalid body: require { chat_id: number, text: string }' });
  }

  // Allowlist check: chat_id must be in tenants.allowed_telegram_user_ids.
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

  if (!allowedIds.includes(body.chat_id)) {
    return jsonRes(403, {
      error: `telegram/send: chat_id ${body.chat_id} not in tenant ${body.tenantId} allowlist`,
    });
  }

  // Forward to the Bot API via the routines/telegram-bot helper.
  try {
    const result = await sendTelegramMessage(
      { chatId: body.chat_id, text: body.text },
      {
        fetch,
        botToken,
        sleep: (ms: number) =>
          new Promise<void>((r) => {
            setTimeout(r, ms);
          }),
      },
    );
    return jsonRes(200, { ok: true, telegramMessageId: result.message_id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return jsonRes(502, { error: `telegram/send: ${msg.slice(0, 256)}` });
  }
}
