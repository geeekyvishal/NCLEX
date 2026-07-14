import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: {
      NODE_ENV: "test",
      DATABASE_URL: "postgres://mock:mock@localhost:5432/mock",
      REDIS_URL: "redis://localhost:6379",
      SESSION_COOKIE_SECRET: "mock-session-cookie-secret-minimum-32-chars-long",
      S3_ENDPOINT: "http://localhost:9000",
      S3_BUCKET: "mock-bucket",
      S3_ACCESS_KEY: "mock-access",
      S3_SECRET_KEY: "mock-secret",
    },
  },
});
