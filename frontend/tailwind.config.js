/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        void: '#000000',
        iris: '#8052ff',
        saffron: '#ffb829',
        verdant: '#15846e',
        bone: '#ffffff',
        silver: '#bdbdbd',
      },
      spacing: {
        '120': '120px',
      },
      fontSize: {
        'heading-sm': ['42px', { letterSpacing: '-1.68px' }],
        'heading': ['48px', { letterSpacing: '-1.68px' }],
      },
      fontFamily: {
        sans: ['PPNeueMontreal', 'Inter', 'sans-serif'],
      }
    },
  },
  plugins: [],
}
