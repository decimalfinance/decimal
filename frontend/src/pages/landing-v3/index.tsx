// @ts-nocheck
// Landing v3 — ported from the Claude-design handoff (decimal latest landing.zip).
// Assembles the globe hero + section components and wires the scroll-reveal observer.
import { useEffect } from 'react';
import { GlobeHeroSphere } from './hero';
import {
  TrustStrip,
  PaymentsSection,
  CrossBorderSection,
  CodingSection,
  ApprovalsSection,
  SecuritySection,
  SpendingLimitsSection,
  FeatureGridSection,
  FaqSection,
  ClosingCTASection,
  FooterSection,
} from './sections';
import './page.css';
import './responsive.css';

export function LandingPage() {
  useEffect(() => {
    // scroll-driven reveal for the four split sections (coding/approvals/security/limits)
    document.documentElement.classList.add('reveal-on');
    const obs = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add('in');
            obs.unobserve(e.target);
          }
        });
      },
      { threshold: 0, rootMargin: '0px 0px -12% 0px' },
    );
    const sections = document.querySelectorAll(
      '.sec-coding, .sec-approvals, .sec-security, .sec-limits',
    );
    sections.forEach((s) => obs.observe(s));
    return () => {
      obs.disconnect();
      document.documentElement.classList.remove('reveal-on');
    };
  }, []);

  return (
    <div className="lpv3-page">
      <GlobeHeroSphere preset="magenta" full={true} />
      <TrustStrip />
      <div id="sec-payments">
        <PaymentsSection />
      </div>
      <div id="sec-xborder">
        <CrossBorderSection />
      </div>
      <div id="sec-coding">
        <CodingSection />
      </div>
      <div id="sec-approvals">
        <ApprovalsSection />
      </div>
      <div id="sec-security">
        <SecuritySection />
      </div>
      <SpendingLimitsSection />
      <FeatureGridSection />
      <div id="sec-faq">
        <FaqSection />
      </div>
      <ClosingCTASection />
      <FooterSection />
    </div>
  );
}

export default LandingPage;
