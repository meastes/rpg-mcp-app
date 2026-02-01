/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{html,js,ts,tsx}"],
  theme: {
    extend: {
      boxShadow: {
        glow: "0 0 0 1px rgba(45, 212, 191, 0.3), 0 20px 60px rgba(12, 18, 35, 0.45)",
      },
    },
  },
  plugins: [],
};
