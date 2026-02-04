/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingIncludes: {
    "/api/*": ["web/dist/**"],
  },
};

module.exports = nextConfig;
