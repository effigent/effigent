/** @type {import('next').NextConfig} */
const nextConfig = {
  // Full-stack app (UI + API route handlers) on Vercel serverless.
  // Heavy routes set their own maxDuration via `export const maxDuration`.
  reactStrictMode: true,
};

export default nextConfig;
