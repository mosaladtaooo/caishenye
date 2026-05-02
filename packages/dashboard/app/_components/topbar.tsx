/**
 * Top-bar navigation. Single chrome strip — terminal feel, not a fat
 * sidebar. Five fixed routes for v1 + brand on the left + GMT clock on
 * the right. The clock confirms the operator's reference frame is GMT
 * (constitution §5).
 */

import { GmtClock } from './gmt-clock';

export function Topbar(): React.ReactElement {
  return (
    <header className="topbar">
      <span className="topbar-brand">财神爷 / mission-control</span>
      <nav className="topbar-nav">
        <a href="/">overview</a>
        <a href="/schedule">schedule</a>
        <a href="/history">history</a>
        <a href="/overrides">overrides</a>
      </nav>
      <GmtClock />
    </header>
  );
}
