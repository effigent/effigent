/** @type {import('next').NextConfig} */
const nextConfig = {
  // Static HTML export → deploys to S3/CloudFront as plain files, fully
  // pre-rendered (real content + metadata in the HTML for SEO). No server.
  output: 'export',
  images: { unoptimized: true },
  trailingSlash: true,
};

export default nextConfig;
