'use client';

/**
 * /auth/login form -- thin wrapper around PasskeyClient(mode='authenticate').
 */

import { PasskeyClient } from '../passkey/PasskeyClient';

export function PasskeyLoginForm(): React.ReactElement {
  return <PasskeyClient mode="authenticate" />;
}
