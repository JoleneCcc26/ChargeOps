/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        surface: {
          DEFAULT: "#0f1419",
          raised: "#1a2332",
          muted: "#243044",
        },
        accent: {
          DEFAULT: "#22c55e",
          dim: "#16a34a",
          glow: "#4ade80",
        },
        ink: {
          DEFAULT: "#e8eef4",
          muted: "#94a3b8",
          faint: "#64748b",
        },
      },
      fontFamily: {
        sans: [
          "DM Sans",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "sans-serif",
        ],
        display: ["Outfit", "DM Sans", "system-ui", "sans-serif"],
      },
      boxShadow: {
        card: "0 1px 0 rgba(255,255,255,0.06) inset, 0 4px 24px rgba(0,0,0,0.35)",
        glow: "0 0 40px rgba(34, 197, 94, 0.12)",
      },
    },
  },
  plugins: [],
};
