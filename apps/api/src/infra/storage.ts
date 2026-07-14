/**
 * S3-compatible object storage client (works with AWS S3 and MinIO).
 *
 * `forcePathStyle` is enabled so a MinIO endpoint like http://localhost:9000
 * addresses buckets by path (`/bucket/key`) rather than by virtual host, which
 * MinIO does not serve by default.
 */
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { config } from "../config.js";

let s3Singleton: S3Client | null = null;

/** Return the shared S3 client, creating it on first call. */
export function getS3(): S3Client {
  if (s3Singleton === null) {
    s3Singleton = new S3Client({
      endpoint: config.S3_ENDPOINT,
      region: config.S3_REGION,
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.S3_ACCESS_KEY,
        secretAccessKey: config.S3_SECRET_KEY,
      },
    });
  }
  return s3Singleton;
}

/** Upload a buffer to the configured bucket and return the storage key. */
export async function putObject(
  key: string,
  body: Buffer,
  contentType: string,
): Promise<string> {
  await getS3().send(
    new PutObjectCommand({
      Bucket: config.S3_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
  return key;
}
