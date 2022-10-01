/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx,css,md,mdx,html,json,scss}",
  ],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        kabootarBlue: "#007CF0",
        kabootarCyan: "#00DFD8",
      },
    },
  },
  plugins: [],
};
