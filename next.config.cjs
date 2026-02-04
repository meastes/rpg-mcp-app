/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingIncludes: {
    "/api/*": ["web/dist/**"],
    "/mcp": ["web/dist/**"],
  },
};

module.exports = nextConfig;
