import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import '../styles/landing.css';
import { CodeWall } from './landing/CodeWall';
import { IconArrowRight, IconMoon, IconSun } from './landing/Icons';
import { Hero } from './landing/Hero';
import { ConveyorHero } from './landing/heroVisuals/ConveyorHero';
import { Workflow } from './landing/Workflow';
import { Features } from './landing/Features';
import { FinalCTA } from './landing/FinalCTA';

const THEME_KEY = 'axoria.theme';
const LEGACY_THEME_KEY = 'ax-theme';

type Theme = 'dark' | 'light';

function readTheme(): Theme {
  try {
    const v =
      window.localStorage.getItem(THEME_KEY) ?? window.localStorage.getItem(LEGACY_THEME_KEY);
    if (v === 'light' || v === 'dark') return v;
  } catch {
    // ignore
  }
  const current = document.documentElement.getAttribute('data-theme');
  return current === 'light' ? 'light' : 'dark';
}

export function LandingPage() {
  const [theme, setTheme] = useState<Theme>(readTheme);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try {
      window.localStorage.setItem(THEME_KEY, theme);
    } catch {
      // ignore
    }
  }, [theme]);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const toggleTheme = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'));

  return (
    <div className="landing-root">
      <CodeWall />
      <nav className="lp-nav" data-scrolled={scrolled ? 'true' : 'false'}>
        <div className="lp-container lp-nav-inner">
          <Link to="/" className="lp-brand">
            <span>Axoria</span>
          </Link>
          <div className="lp-nav-links">
            <a href="#how" className="hide-m">
              How it works
            </a>
            <a href="#features" className="hide-m">
              Features
            </a>
            <button
              type="button"
              className="lp-theme-toggle"
              onClick={toggleTheme}
              aria-label="Toggle theme"
            >
              {theme === 'dark' ? <IconSun /> : <IconMoon />}
            </button>
            <Link
              to="/login"
              className="lp-btn lp-btn-primary"
              style={{ height: 34, fontSize: 13 }}
            >
              Get started <IconArrowRight size={12} />
            </Link>
          </div>
        </div>
      </nav>
      <main>
        <Hero startHref="/login" visual={<ConveyorHero accent="var(--ax-accent)" />} />
        <Workflow />
        <Features />
        <FinalCTA startHref="/login" />
      </main>
      <footer className="lp-footer">
        <div className="lp-container lp-footer-inner">
          <Link to="/" className="lp-brand">
            Axoria
          </Link>
          <span className="mono" style={{ fontSize: 11, color: 'var(--ax-text-faint)' }}>
            © 2026 Axoria Labs · Built on Solana
          </span>
        </div>
      </footer>
    </div>
  );
}
