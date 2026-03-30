import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        primary: {
          50: "#fef9f0",
          100: "#fed8bd",
          200: "#fcb881",
          300: "#fb9845",
          400: "#fa8422",
          500: "#d46f1f",
          600: "#ad591b",
          700: "#864316",
          800: "#5f2d12",
          900: "#38180c",
        },
        warm: {
          50: "#fdfbf7",
          100: "#f5ede0",
          200: "#eee0cc",
          300: "#e8d4b8",
          400: "#e1c7a3",
          500: "#dab98f",
          600: "#c9a575",
          700: "#b8915b",
          800: "#a77d41",
          900: "#966927",
        },
      },
      fontFamily: {
        sans: [
          '"Noto Sans JP"',
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'BlinkMacSystemFont',
          'sans-serif',
        ],
      },
    },
  },
  plugins: [],
};

export default config;
