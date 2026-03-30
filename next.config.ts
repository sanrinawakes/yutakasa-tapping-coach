import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  headers: async () => {
    return [
      {
        source: "/api/:path*",
        headers: [
          {
            key: "Content-Type",
            value: "application/json",
          },
        ],
      },
    ];
  },
};

export default config;
