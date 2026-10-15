import plugin from 'tailwindcss/plugin';

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    screens: {
      'xs': '360px',
      'sm': '480px',
      'md': '600px',
      'lg': '1025px',
      'xl': '1280px',
      '2xl': '1536px',
    },
    extend: {},
  },
  plugins: [
    // Height-based variants; registered in this order so `low:` overrides `short:` when both match.
    plugin(({ addVariant }) => {
      addVariant('short', '@media (max-height: 640px)');
      addVariant('low', '@media (max-height: 520px)');
    }),
  ],
};
