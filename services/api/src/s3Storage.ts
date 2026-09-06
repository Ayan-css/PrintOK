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

export class S3StorageService {
  private s3Client: S3Client | null = null;
  private bucketName: string;
  private localStorageDir: string;

  constructor() {
    this.bucketName = process.env.S3_BUCKET_NAME || 'printok-temp-documents';
    this.localStorageDir = path.join(process.cwd(), 'tmp_storage');

    const endpoint = process.env.S3_ENDPOINT;
    const accessKeyId = process.env.S3_ACCESS_KEY_ID;
    const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;

    if (endpoint && accessKeyId && secretAccessKey) {
      this.s3Client = new S3Client({
        region: process.env.S3_REGION || 'us-east-1',
        endpoint,
        credentials: {
          accessKeyId,
          secretAccessKey,
        },
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
   * Save temporary document payload and return access URLs
   */
  public async storeDocument(
    jobId: string,
    fileName: string,
    fileBase64: string
  ): Promise<StorageObjectResult> {
    const s3Key = `temp_docs/${jobId}_${fileName}`;
    const fileBuffer = Buffer.from(fileBase64, 'base64');

    if (this.s3Client) {
      const command = new PutObjectCommand({
        Bucket: this.bucketName,
        Key: s3Key,
        Body: fileBuffer,
        ContentType: 'application/pdf',
        Metadata: { jobId },
      });

      await this.s3Client.send(command);

      const getCommand = new GetObjectCommand({
        Bucket: this.bucketName,
        Key: s3Key,
      });

      // Presigned download URL valid for 1 hour
      const presignedDownloadUrl = await getSignedUrl(this.s3Client, getCommand, { expiresIn: 3600 });

      return {
        s3Key,
        fileUrl: presignedDownloadUrl,
        presignedDownloadUrl,
      };
    } else {
      // Local fallback
      const localFilePath = path.join(this.localStorageDir, `${jobId}_${fileName}`);
      fs.writeFileSync(localFilePath, fileBuffer);
      const fileUrl = `data:application/pdf;base64,${fileBase64}`;

      return {
        s3Key,
        fileUrl,
      };
    }
  }

  /**
   * Immediate document deletion for privacy upon print completion
   */
  public async deleteDocument(s3Key: string): Promise<void> {
    if (this.s3Client) {
      try {
        const command = new DeleteObjectCommand({
          Bucket: this.bucketName,
          Key: s3Key,
        });
        await this.s3Client.send(command);
        console.log(`[S3 Storage] Successfully deleted S3 object '${s3Key}'`);
      } catch (err) {
        console.warn(`[S3 Storage] Failed to delete S3 object '${s3Key}':`, err);
      }
    } else {
      // Delete local fallback file
      const fileName = path.basename(s3Key);
      const localFilePath = path.join(this.localStorageDir, fileName);
      if (fs.existsSync(localFilePath)) {
        try {
          fs.unlinkSync(localFilePath);
          console.log(`[S3 Storage] Deleted local temp storage file '${localFilePath}'`);
        } catch (err) {
          console.warn(`[S3 Storage] Failed to delete local temp file '${localFilePath}':`, err);
        }
      }
    }
  }
}
