import type { Config } from 'tailwindcss';

/**
 * One breakpoint scale for the whole app.
 *
 * The same build runs on a 320px phone and a 1280px tablet, so layout decisions
 * are made against available width rather than against a device type. The
 * names describe the shape of the screen, not the hardware:
 *
 *   default  small phones          (<480px)  single column, bottom navigation
 *   xs       standard phones       (>=480px) roomier single column
 *   sm       large phones/phablets (>=640px) two-column cards, side-by-side fields
 *   md       small tablets         (>=768px) sidebar navigation, two-pane views
 *   lg       large tablets         (>=1024px) wider grids, master-detail
 *   xl       tablet landscape      (>=1280px) full multi-column dashboards
 */
const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}'],
  darkMode: ['class', '[data-theme="dark"]'],
  theme: {
    screens: {
      xs: '480px',
      sm: '640px',
      md: '768px',
      lg: '1024px',
      xl: '1280px',
      '2xl': '1536px',
    },
    extend: {
      colors: {
        surface: 'rgb(var(--surface) / <alpha-value>)',
        'surface-raised': 'rgb(var(--surface-raised) / <alpha-value>)',
        'surface-sunken': 'rgb(var(--surface-sunken) / <alpha-value>)',
        border: 'rgb(var(--border) / <alpha-value>)',
        content: 'rgb(var(--content) / <alpha-value>)',
        'content-muted': 'rgb(var(--content-muted) / <alpha-value>)',
        brand: 'rgb(var(--brand) / <alpha-value>)',
        'brand-contrast': 'rgb(var(--brand-contrast) / <alpha-value>)',
        positive: 'rgb(var(--positive) / <alpha-value>)',
        caution: 'rgb(var(--caution) / <alpha-value>)',
        critical: 'rgb(var(--critical) / <alpha-value>)',
      },
      spacing: {
        // Android status bar and gesture navigation insets, supplied by
        // Capacitor's safe-area handling.
        'safe-top': 'env(safe-area-inset-top, 0px)',
        'safe-bottom': 'env(safe-area-inset-bottom, 0px)',
      },
      minHeight: {
        // Comfortably above the 48dp Android accessibility minimum.
        tap: '48px',
      },
      minWidth: { tap: '48px' },
    },
  },
  plugins: [],
};

export default config;
