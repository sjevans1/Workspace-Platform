const config = {
  poweredByHeader: false,
  experimental: { externalDir: true },
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${process.env.API_INTERNAL_URL || "http://127.0.0.1:4000"}/api/:path*`,
      },
    ];
  },
};
export default config;
