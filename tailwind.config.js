/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        steam: {
          darkest: '#0e141b',
          dark: '#171a21',
          bg: '#1b2838',
          card: '#16202d',
          border: '#2a475e',
          accent: '#66c0f4',
          accentHover: '#ffffff',
          text: '#c6d4df',
          subtext: '#8f98a0',
          positive: '#66c0f4',
          positiveGreen: '#5c7e10',
          btnGreen: '#6a9e18',
          btnGreenHover: '#8bc53f'
        }
      },
      fontFamily: {
        steam: ['"Motiva Sans"', 'system-ui', '-apple-system', 'sans-serif']
      }
    },
  },
  plugins: [],
}
