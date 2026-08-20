import { normalizeStorageKey } from './index.mjs'

async function streamToBuffer(body) {
  if (!body) return Buffer.alloc(0)
  if (typeof body.transformToByteArray === 'function') return Buffer.from(await body.transformToByteArray())
  const chunks = []
  for await (const chunk of body) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

export function createS3Storage(options) {
  const {
    bucket,
    endpoint,
    region,
    accessKeyId,
    secretAccessKey,
    forcePathStyle,
    signedUrlExpiresSeconds,
  } = options
  if (!bucket) throw new TypeError('S3_BUCKET이 필요합니다.')
  if (!options.client && (!accessKeyId || !secretAccessKey)) throw new TypeError('S3 접근 자격정보가 필요합니다.')

  let resourcesPromise
  const resources = async () => {
    resourcesPromise ??= (async () => {
      const sdk = await import('@aws-sdk/client-s3')
      const presigner = await import('@aws-sdk/s3-request-presigner')
      const client = options.client ?? new sdk.S3Client({
        region,
        endpoint: endpoint || undefined,
        forcePathStyle,
        credentials: { accessKeyId, secretAccessKey },
      })
      return { ...sdk, client, signer: options.signer ?? presigner.getSignedUrl }
    })()
    return resourcesPromise
  }

  return {
    backend: 's3',
    async put(key, body, metadata = {}) {
      const normalized = normalizeStorageKey(key)
      const value = Buffer.isBuffer(body) ? body : Buffer.from(body)
      const { client, PutObjectCommand } = await resources()
      await client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: normalized,
        Body: value,
        ContentType: metadata.contentType || 'application/octet-stream',
        Metadata: metadata.metadata,
      }))
      return { key: normalized, size: value.length }
    },
    async get(key) {
      const normalized = normalizeStorageKey(key)
      const { client, GetObjectCommand } = await resources()
      try {
        const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: normalized }))
        return await streamToBuffer(result.Body)
      } catch (error) {
        if (error?.name === 'NoSuchKey' || error?.$metadata?.httpStatusCode === 404) {
          const notFound = new Error('파일을 찾을 수 없습니다.')
          notFound.code = 'STORAGE_NOT_FOUND'
          throw notFound
        }
        throw error
      }
    },
    async delete(key) {
      const normalized = normalizeStorageKey(key)
      const { client, DeleteObjectCommand } = await resources()
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: normalized }))
      return true
    },
    async getSignedUrl(key, options = {}) {
      const normalized = normalizeStorageKey(key)
      const { client, GetObjectCommand, signer } = await resources()
      const command = new GetObjectCommand({
        Bucket: bucket,
        Key: normalized,
        ResponseContentType: options.contentType,
        ResponseContentDisposition: options.downloadName
          ? `attachment; filename*=UTF-8''${encodeURIComponent(options.downloadName)}`
          : undefined,
      })
      return signer(client, command, { expiresIn: Math.max(30, Math.min(3_600, Number(options.expiresIn ?? signedUrlExpiresSeconds ?? 300))) })
    },
  }
}

