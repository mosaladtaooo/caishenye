/**
 * AC-023-5 -- EmergencyTokenBanner.
 *
 * Renders a banner on the /overview screen when:
 *   process.env.EMERGENCY_TOKEN_LOGIN_ENABLED === 'true'  AND
 *   both registered authenticators have last_used_at <= 7 days old
 *
 * Banner copy (per contract): "You can now disable emergency token login:
 *   vercel env edit production EMERGENCY_TOKEN_LOGIN_ENABLED false"
 *
 * Banner does NOT auto-flip (OWASP Misconfiguration mitigation: human in
 * the loop on the trapdoor close). The async query for both-authenticator
 * 7-day freshness is the caller's responsibility -- this component is a
 * pure render based on the readiness boolean.
 */

interface EmergencyTokenBannerProps {
  /**
   * True iff EMERGENCY_TOKEN_LOGIN_ENABLED='true' AND the 7-day-passkey
   * freshness condition is met for BOTH registered authenticators.
   */
  readyToDisable: boolean;
}

export function EmergencyTokenBanner({
  readyToDisable,
}: EmergencyTokenBannerProps): React.ReactElement | null {
  if (!readyToDisable) return null;
  return (
    <aside
      style={{
        margin: '1rem 0',
        padding: '0.75rem 1rem',
        background: '#1d3a4a',
        color: '#bfe',
        border: '1px solid #2a5168',
        borderRadius: '4px',
        fontSize: '0.875rem',
        fontFamily: 'monospace',
      }}
    >
      <strong>Hardening checkpoint reached.</strong> You can now disable emergency token login:{' '}
      <code>vercel env edit production EMERGENCY_TOKEN_LOGIN_ENABLED false</code>
    </aside>
  );
}
