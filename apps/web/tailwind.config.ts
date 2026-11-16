import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // RGB triplets live in globals.css so the whole palette can swap
        // between the dark hall and the light day theme at runtime.
        ink: 'rgb(var(--c-ink) / <alpha-value>)',
        panel: 'rgb(var(--c-panel) / <alpha-value>)',
        raised: 'rgb(var(--c-raised) / <alpha-value>)',
        line: 'rgb(var(--c-line) / <alpha-value>)',
        text: 'rgb(var(--c-text) / <alpha-value>)',
        muted: 'rgb(var(--c-muted) / <alpha-value>)',
        gold: 'rgb(var(--c-gold) / <alpha-value>)',
        mint: 'rgb(var(--c-mint) / <alpha-value>)',
        danger: 'rgb(var(--c-danger) / <alpha-value>)',
        warn: 'rgb(var(--c-warn) / <alpha-value>)',
        blue: 'rgb(var(--c-blue) / <alpha-value>)',
        violet: 'rgb(var(--c-violet) / <alpha-value>)',
        rose: 'rgb(var(--c-rose) / <alpha-value>)',
      },
      fontFamily: {
        display: ['"Trebuchet MS"', '"Segoe UI"', 'system-ui', 'sans-serif'],
        sans: ['"Segoe UI"', 'system-ui', '-apple-system', 'Roboto', 'sans-serif'],
      },
      boxShadow: {
        glow: '0 0 0 1px rgb(var(--c-mint) / 0.18), 0 18px 48px -24px rgb(var(--c-mint) / 0.45)',
        card: 'var(--shadow-card)',
        float: 'var(--shadow-float)',
      },
      keyframes: {
        pulseBall: {
          '0%': { transform: 'scale(.85)', opacity: '0.4' },
          '60%': { transform: 'scale(1.06)' },
          '100%': { transform: 'scale(1)', opacity: '1' },
        },
        rise: {
          '0%': { transform: 'translateY(8px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
      },
      animation: {
        ball: 'pulseBall .45s ease-out',
        rise: 'rise .35s ease-out',
      },
    },
  },
  plugins: [],
};

export default config;
