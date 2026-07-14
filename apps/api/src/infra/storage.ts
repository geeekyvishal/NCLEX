/**
 * S3-compatible object storage client (works with AWS S3 and MinIO).
 *
 * `forcePathStyle` is enabled so a MinIO endpoint like http://localhost:9000
 * addresses buckets by path (`/bucket/key`) rather than by virtual host, which
 * MinIO does not serve by default.
 */
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  CreateBucketCommand,
  HeadBucketCommand,
} from "@aws-sdk/client-s3";
import { config } from "../config.js";

let s3Singleton: S3Client | null = null;
let bucketEnsured = false;

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

/**
 * Ensure the configured bucket exists, creating it if it does not.
 * Idempotent - safe to call on every request; the flag short-circuits after first success.
 */
export async function ensureBucket(): Promise<void> {
  if (bucketEnsured) return;
  const s3 = getS3();
  try {
    await s3.send(new HeadBucketCommand({ Bucket: config.S3_BUCKET }));
  } catch (e: unknown) {
    const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (err.name === "NotFound" || err.$metadata?.httpStatusCode === 404) {
      await s3.send(new CreateBucketCommand({ Bucket: config.S3_BUCKET }));
    } else {
      throw e;
    }
  }
  bucketEnsured = true;
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

/** Delete an object from the configured bucket. */
export async function deleteObject(key: string): Promise<void> {
  await getS3().send(
    new DeleteObjectCommand({
      Bucket: config.S3_BUCKET,
      Key: key,
    }),
  );
}
