import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#050d0b',
        panel: '#0b1a15',
        raised: '#10241d',
        line: '#1d3a30',
        text: '#eef6f1',
        muted: '#8aa79a',
        gold: '#f3c969',
        mint: '#37e0a0',
        danger: '#ff6b6b',
        warn: '#ffb347',
      },
      fontFamily: {
        display: ['"Trebuchet MS"', '"Segoe UI"', 'system-ui', 'sans-serif'],
        sans: ['"Segoe UI"', 'system-ui', '-apple-system', 'Roboto', 'sans-serif'],
      },
      boxShadow: {
        glow: '0 0 0 1px rgba(55,224,160,.18), 0 18px 48px -24px rgba(55,224,160,.45)',
        card: '0 18px 40px -28px rgba(0,0,0,.9)',
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
