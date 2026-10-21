import { fileURLToPath } from 'node:url';

// The self-hosted image (Dockerfile.console) builds with NEXT_OUTPUT=standalone:
// a self-contained server.js, its dependencies traced from the monorepo root.
// The Vercel build never sets it and is unchanged.
const standalone = process.env.NEXT_OUTPUT === 'standalone';

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Full-stack app (UI + API route handlers) on Vercel serverless.
  // Heavy routes set their own maxDuration via `export const maxDuration`.
  reactStrictMode: true,
  ...(standalone ? { output: 'standalone', outputFileTracingRoot: fileURLToPath(new URL('../..', import.meta.url)) } : {}),
};

export default nextConfig;
