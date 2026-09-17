import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import fs from 'fs';
import path from 'path';

export interface StorageObjectResult {
  s3Key: string;
  fileUrl: string;
  presignedUploadUrl?: string;
  presignedDownloadUrl?: string;
}

/**
 * How long a minted download link is good for.
 *
 * Short on purpose. The link used to be generated once at upload with an hour's
 * life and then stored on the job row, which made it a standing bearer token
 * for the document: anyone who came by the job id within the hour could
 * download a customer's file with no credential at all. It is now minted on
 * demand, for the authenticated agent that is about to print, and expires
 * before it can be passed around.
 */
const DOWNLOAD_URL_TTL_SECONDS = 300;

/** Content types for what the upload form actually accepts. */
const CONTENT_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.csv': 'text/csv',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export class S3StorageService {
  private s3Client: S3Client | null = null;
  private bucketName: string;
  private localStorageDir: string;

  constructor() {
    this.bucketName = process.env.S3_BUCKET_NAME || 'printok-temp-documents';
    this.localStorageDir = path.resolve(process.cwd(), 'tmp_storage');

    const endpoint = process.env.S3_ENDPOINT;
    const accessKeyId = process.env.S3_ACCESS_KEY_ID;
    const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
    const configured = Boolean(endpoint && accessKeyId && secretAccessKey);

    // Production refuses the local-disk fallback rather than taking it quietly.
    //
    // All three variables are operator-set, so an incompletely configured
    // deploy used to land on local disk silently — writing customers' documents
    // to an ephemeral container filesystem, and inlining every one of them into
    // its database row as a base64 data URI. Failing the boot names the missing
    // configuration instead of discovering it months later.
    if (!configured && process.env.NODE_ENV === 'production') {
      const missing = [
        !endpoint && 'S3_ENDPOINT',
        !accessKeyId && 'S3_ACCESS_KEY_ID',
        !secretAccessKey && 'S3_SECRET_ACCESS_KEY',
      ].filter(Boolean);

      throw new Error(
        'Refusing to start: object storage is not configured, and the local-disk ' +
        `fallback is not safe for production. Missing: ${missing.join(', ')}.`
      );
    }

    if (configured) {
      this.s3Client = new S3Client({
        region: process.env.S3_REGION || 'us-east-1',
        endpoint,
        credentials: { accessKeyId: accessKeyId!, secretAccessKey: secretAccessKey! },
        forcePathStyle: true, // Needed for MinIO / local S3 emulators
      });
      console.log(`[S3 Storage] Configured S3 Object Storage (${endpoint}, Bucket: ${this.bucketName})`);
    } else {
      if (!fs.existsSync(this.localStorageDir)) {
        fs.mkdirSync(this.localStorageDir, { recursive: true });
      }
      console.log(`[S3 Storage] S3 credentials not set; using local file storage fallback at ${this.localStorageDir}`);
    }
  }

  /**
   * The object name for a job's document: the job id and nothing else.
   *
   * The customer's filename used to be interpolated straight in, so
   * `"../../../etc/cron.d/x.pdf"` walked out of the storage directory and wrote
   * attacker bytes wherever it landed — and, pointed back inside, overwrote
   * another pending job's document, so the shop printed the attacker's content
   * under someone else's token. The extension check did not help: it used
   * `lastIndexOf('.')`, which reads that path as a perfectly good `.pdf`.
   *
   * The job id is ours and is hex, so the whole key is now trusted by
   * construction. The customer's own filename is still kept on the job row for
   * the queue to display; it just no longer decides where anything is written.
   */
  private static storageKeyFor(jobId: string, fileName: string): string {
    const safeJobId = path.basename(jobId).replace(/[^A-Za-z0-9._-]/g, '');
    const ext = path.extname(path.basename(fileName || '')).toLowerCase().replace(/[^a-z0-9.]/g, '');
    return `temp_docs/${safeJobId}${ext}`;
  }

  /**
   * Where a key lives on local disk, proven to be inside the storage directory.
   *
   * Belt to the braces of the key construction above: even if a key reached
   * here with traversal in it, this refuses rather than writing outside.
   */
  private localPathFor(s3Key: string): string {
    const resolved = path.resolve(this.localStorageDir, path.basename(s3Key));
    const root = this.localStorageDir + path.sep;

    if (!resolved.startsWith(root)) {
      throw new Error('Refusing to touch a storage path outside the storage directory.');
    }

    return resolved;
  }

  /**
   * Save temporary document payload.
   *
   * Deliberately returns an empty `fileUrl`. A usable link is minted on demand
   * by `createDownloadUrl` for the authenticated agent that is about to print,
   * rather than stored on the job row where it outlived the job's need for it.
   */
  public async storeDocument(
    jobId: string,
    fileName: string,
    fileBase64: string
  ): Promise<StorageObjectResult> {
    const s3Key = S3StorageService.storageKeyFor(jobId, fileName);
    const fileBuffer = Buffer.from(fileBase64, 'base64');

    if (this.s3Client) {
      await this.s3Client.send(new PutObjectCommand({
        Bucket: this.bucketName,
        Key: s3Key,
        Body: fileBuffer,
        ContentType: CONTENT_TYPES[path.extname(s3Key)] || 'application/octet-stream',
        Metadata: { jobId },
      }));
    } else {
      fs.writeFileSync(this.localPathFor(s3Key), fileBuffer);
    }

    return { s3Key, fileUrl: '' };
  }

  /**
   * A short-lived link to a stored document, for a caller already authorised to
   * have it.
   *
   * Returns null when the object is gone, which is the normal case for a job
   * whose document has been purged — the caller reports that rather than
   * handing the agent a link to nothing.
   */
  public async createDownloadUrl(s3Key: string): Promise<string | null> {
    if (!s3Key) return null;

    if (this.s3Client) {
      try {
        return await getSignedUrl(
          this.s3Client,
          new GetObjectCommand({ Bucket: this.bucketName, Key: s3Key }),
          { expiresIn: DOWNLOAD_URL_TTL_SECONDS }
        );
      } catch (err) {
        console.warn('[S3 Storage] Could not sign a download URL for a stored document:', err);
        return null;
      }
    }

    // Local fallback: the agent accepts a data URI, so the bytes are read at
    // the moment they are needed instead of being kept in the database.
    try {
      const localFilePath = this.localPathFor(s3Key);
      if (!fs.existsSync(localFilePath)) return null;
      const contentType = CONTENT_TYPES[path.extname(s3Key)] || 'application/octet-stream';
      return `data:${contentType};base64,${fs.readFileSync(localFilePath).toString('base64')}`;
    } catch (err) {
      console.warn('[S3 Storage] Could not read a stored document from local storage:', err);
      return null;
    }
  }

  /**
   * Immediate document deletion for privacy upon print completion
   */
  public async deleteDocument(s3Key: string): Promise<void> {
    if (!s3Key) return;

    if (this.s3Client) {
      try {
        await this.s3Client.send(new DeleteObjectCommand({
          Bucket: this.bucketName,
          Key: s3Key,
        }));
        // The job id, not the key: the key is derived from it and a filename
        // has no business in a log line.
        console.log('[S3 Storage] Deleted stored document for job', path.basename(s3Key));
      } catch (err) {
        console.warn('[S3 Storage] Failed to delete a stored document:', err);
      }
      return;
    }

    try {
      const localFilePath = this.localPathFor(s3Key);
      if (fs.existsSync(localFilePath)) {
        fs.unlinkSync(localFilePath);
        console.log('[S3 Storage] Deleted local stored document for job', path.basename(s3Key));
      }
    } catch (err) {
      console.warn('[S3 Storage] Failed to delete a local stored document:', err);
    }
  }
}
