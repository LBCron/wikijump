import { client } from "$lib/server/deepwell"

import type { RequestContext } from "../request-context"

export { uploadToPresignUrl } from "$lib/server/deepwell/presigned-upload"

export interface PublicBlobByHash {
  data: number[]
  mime: string
  size: number
  created_at: string
}

export async function getFileByHash(fileHash: Uint8Array | string): Promise<Blob> {
  const res: PublicBlobByHash = await client.request(
    "blob_get",
    typeof fileHash === "string" ? fileHash : Buffer.from(fileHash).toString("hex")
  )

  return new Blob([new Uint8Array(res.data)], { type: res.mime })
}

export type BlobUploadScope = "unscoped" | "page"

export async function startBlobUpload(
  userId: number,
  blobSize: number,
  scope: BlobUploadScope,
  requestContext: RequestContext
) {
  return await client.request(
    "blob_upload",
    {
      user_id: userId,
      blob_size: blobSize,
      scope
    },
    requestContext
  )
}

export async function cancelBlobUpload(
  userId: number,
  pendingBlobId: string,
  requestContext: RequestContext
) {
  return await client.request(
    "blob_cancel",
    {
      user_id: userId,
      pending_blob_id: pendingBlobId
    },
    requestContext
  )
}
