/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./src/**/*.{js,jsx,ts,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        surface: 'rgb(var(--surface) / <alpha-value>)',
        panel: 'rgb(var(--panel) / <alpha-value>)',
        raised: 'rgb(var(--raised) / <alpha-value>)',
        sunken: 'rgb(var(--sunken) / <alpha-value>)',
        hover: 'rgb(var(--hover) / <alpha-value>)',
        active: 'rgb(var(--active) / <alpha-value>)',
        line: 'rgb(var(--line) / <alpha-value>)',
        'rule-control': 'var(--rule-control)',
        'rule-divide': 'var(--rule-divide)',
        'rule-hairline': 'var(--rule-hairline)',
        'rule-seam': 'var(--rule-seam)',
        overlay: 'rgb(var(--overlay) / <alpha-value>)',
        ink: {
          DEFAULT: 'rgb(var(--ink) / <alpha-value>)',
          muted: 'rgb(var(--ink-muted) / <alpha-value>)',
          subtle: 'rgb(var(--ink-subtle) / <alpha-value>)',
          inverted: 'rgb(var(--ink-inverted) / <alpha-value>)',
        },
        accent: {
          DEFAULT: 'rgb(var(--accent) / <alpha-value>)',
          hover: 'rgb(var(--accent-hover) / <alpha-value>)',
          fg: 'rgb(var(--accent-fg) / <alpha-value>)',
        },
        success: {
          DEFAULT: 'rgb(var(--success) / <alpha-value>)',
          hover: 'rgb(var(--success-hover) / <alpha-value>)',
        },
        warning: {
          DEFAULT: 'rgb(var(--warning) / <alpha-value>)',
          hover: 'rgb(var(--warning-hover) / <alpha-value>)',
        },
        danger: {
          DEFAULT: 'rgb(var(--danger) / <alpha-value>)',
          hover: 'rgb(var(--danger-hover) / <alpha-value>)',
          fg: 'rgb(var(--danger-fg) / <alpha-value>)',
        },
      },
      fontFamily: {
        sans: [
          'Noto Sans Variable',
          'Noto Sans',
          'Noto Sans SC Variable',
          'Noto Sans SC',
          'PingFang SC',
          'Microsoft YaHei',
          'system-ui',
          'sans-serif',
        ],
        display: [
          'Instrument Serif',
          'Noto Serif SC Variable',
          'Songti SC',
          'SimSun',
          'serif',
        ],
        reading: [
          'Noto Serif SC Variable',
          'Songti SC',
          'SimSun',
          'serif',
        ],
        mono: [
          'Geist Mono Variable',
          'Geist Mono',
          'Noto Sans SC Variable',
          'Noto Sans SC',
          'Consolas',
          'monospace',
        ],
      },
      borderRadius: {
        DEFAULT: '2px',
        sm: '1px',
        md: '2px',
        lg: '4px',
      },
      boxShadow: {
        print: '5px 6px 0 rgb(var(--shadow-color) / var(--shadow-alpha))',
        panel: '5px 6px 0 rgb(var(--shadow-color) / var(--shadow-alpha))',
      },
      keyframes: {
        'toast-in': {
          from: { opacity: '0', transform: 'translateX(12px)' },
          to: { opacity: '1', transform: 'translateX(0)' },
        },
        'toast-out': {
          from: { opacity: '1', transform: 'translateX(0)' },
          to: { opacity: '0', transform: 'translateX(12px)' },
        },
        breathe: {
          '0%, 100%': { opacity: '0.55' },
          '50%': { opacity: '1' },
        },
      },
      animation: {
        'toast-in': 'toast-in 160ms ease-out',
        'toast-out': 'toast-out 160ms ease-in forwards',
        breathe: 'breathe 2.4s ease-in-out infinite',
      },
    },
  },
  plugins: [],
}
