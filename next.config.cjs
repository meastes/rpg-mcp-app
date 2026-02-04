/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingIncludes: {
    "/api/*": ["web/dist/**"],
  },
  async rewrites() {
    return [
      {
        source: "/mcp",
        destination: "/api/mcp",
      },
    ];
  },
};

module.exports = nextConfig;
