const { Redis } = require("@upstash/redis");

// Vercel (and most serverless hosts) don't offer a persistent local disk or
// long-lived process memory -- every request can land on a fresh instance.
// When Upstash Redis credentials are configured, use that for real
// persistence. Otherwise (plain local dev) fall back to the filesystem/
// in-memory implementations so `npm start` keeps working with zero setup.
const hasRedis = Boolean(
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
);

const redis = hasRedis
  ? new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    })
  : null;

module.exports = { redis, hasRedis };
