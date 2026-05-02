/**
 * Telegram broadcast helper — fires a message via the Bot API to every
 * tenant operator listed in `tenants.allowed_telegram_user_ids` for tenant 1.
 *
 * Used by the override route handlers' R4 7-step flow (step 7) to notify
 * operators when an override action completes. Failure-tolerant per the
 * override-handler contract: if this throws, the caller logs but does NOT
 * roll back the override.
 *
 * The actual sender lives in @caishen/routines/telegram-bot (FR-019); this
 * module owns the routing fan-out (1 message → N chat IDs).
 */

import { getTenantDb } from '@caishen/db/client';
import { sendTelegramMessage } from '@caishen/routines/telegram-bot';
import { eq } from 'drizzle-orm';

export interface BroadcastOptions {
  tenantId?: number;
}

/**
 * Send a message to every operator-allowed Telegram user ID for the tenant.
 *
 * Uses tenant 1 by default. Errors per recipient are caught + logged (a
 * single bad chat ID shouldn't block the others) but the function still
 * resolves; only an env misconfig (missing TELEGRAM_BOT_TOKEN) throws.
 */
export async function sendTelegramBroadcast(
  message: string,
  opts: BroadcastOptions = {},
): Promise<void> {
  const tenantId = opts.tenantId ?? 1;
  const botToken = process.env.TELEGRAM_BOT_TOKEN ?? '';
  if (botToken.length === 0) {
    throw new Error('telegram-broadcast: TELEGRAM_BOT_TOKEN missing in env');
  }

  const tenantDb = getTenantDb(tenantId);
  const { tenants } = await import('@caishen/db/schema/tenants');
  const rows = await tenantDb.drizzle
    .select({ allowed: tenants.allowedTelegramUserIds })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  const row = rows[0];
  if (!row) {
    throw new Error(`telegram-broadcast: tenant ${tenantId} not found`);
  }
  const userIds = (row.allowed as readonly number[] | null) ?? [];

  const deps = {
    fetch,
    botToken,
    sleep: (ms: number) =>
      new Promise<void>((r) => {
        setTimeout(r, ms);
      }),
  };

  for (const chatId of userIds) {
    try {
      await sendTelegramMessage({ chatId, text: message }, deps);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`[telegram-broadcast] chat=${chatId} failed: ${msg}\n`);
    }
  }
}
