/** @type {import('next').NextConfig} */
const nextConfig = {
  webpack(config) {
    // Suppress warnings for optional mongodb peer dependencies
    config.resolve.fallback = {
      ...config.resolve.fallback,
      "@mongodb-js/zstd": false,
      "@aws-sdk/credential-providers": false,
      "gcp-metadata": false,
      snappy: false,
      socks: false,
      aws4: false,
      "mongodb-client-encryption": false,
    }
    return config
  },
}

export default nextConfig
