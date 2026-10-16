import { ObjectId } from "mongodb";
import { ownerScopedQuery } from "../security/ownerQuery.js";

export const CHAT_FILE_LEASE_MS = 15 * 60 * 1000;
export const UPLOAD_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const getUpdatedDocument = (result) => result?.value ?? result ?? null;
const toObjectId = (id) => id instanceof ObjectId ? id : new ObjectId(String(id));

export function collectThreadFileIds(messages = []) {
  return [...new Set(messages.flatMap((message) => (message.attachments || [])
    .map((attachment) => String(attachment.fileId))
    .filter((id) => /^[a-f\d]{24}$/i.test(id))))];
}

export function formatImageGalleryItem(file) {
  return {
    fileId: String(file._id),
    filename: file.filename,
    contentType: file.metadata?.contentType,
    createdAt: file.uploadDate,
    url: `/api/images/${file._id}`
  };
}

export async function reserveFilesForChat({ files, fileIds, ownerId, requestId, now = new Date() }) {
  const acquired = [];
  try {
    for (const rawId of [...new Set(fileIds.map(String))]) {
      const fileId = toObjectId(rawId);
      const result = await files.findOneAndUpdate(ownerScopedQuery(String(ownerId), {
        _id: fileId,
        "metadata.lifecycleState": { $ne: "deleting" },
        $or: [
          { "metadata.activeUntil": { $exists: false } },
          { "metadata.activeUntil": { $lte: now } }
        ]
      }, "metadata.ownerId"), {
        $set: {
          "metadata.activeRequestId": requestId,
          "metadata.activeUntil": new Date(now.getTime() + CHAT_FILE_LEASE_MS)
        }
      }, { returnDocument: "after" });
      if (!getUpdatedDocument(result)) {
        await releaseFilesFromChat({ files, fileIds: acquired, ownerId, requestId });
        return false;
      }
      acquired.push(fileId);
    }
    return acquired;
  } catch (error) {
    await releaseFilesFromChat({ files, fileIds: acquired, ownerId, requestId }).catch(() => {});
    throw error;
  }
}

export async function releaseFilesFromChat({ files, fileIds, ownerId, requestId, committed = false, now = new Date() }) {
  await Promise.all(fileIds.map((rawId) => {
    const update = { $unset: { "metadata.activeRequestId": "", "metadata.activeUntil": "" } };
    if (committed) {
      update.$set = {
        "metadata.lifecycleState": "linked",
        "metadata.cleanupAfter": new Date(now.getTime() + UPLOAD_RETENTION_MS)
      };
      update.$unset["metadata.pendingExpiresAt"] = "";
    }
    return files.updateOne(ownerScopedQuery(String(ownerId), {
      _id: toObjectId(rawId),
      "metadata.activeRequestId": requestId
    }, "metadata.ownerId"), update);
  }));
}

export async function deleteFileIfUnreferenced({ db, bucket, ThreadModel, fileId: rawId, ownerId, includeGenerated = false, pendingOnly = false, now = new Date() }) {
  const fileId = toObjectId(rawId);
  const criteria = {
    _id: fileId,
    "metadata.lifecycleState": { $ne: "deleting" },
    $or: [
      { "metadata.activeUntil": { $exists: false } },
      { "metadata.activeUntil": { $lte: now } }
    ]
  };
  if (!includeGenerated) criteria["metadata.generated"] = false;
  if (pendingOnly) criteria["metadata.lifecycleState"] = "pending";

  const files = db.collection("images.files");
  const claimed = getUpdatedDocument(await files.findOneAndUpdate(
    ownerScopedQuery(String(ownerId), criteria, "metadata.ownerId"),
    { $set: { "metadata.lifecycleState": "deleting" } },
    { returnDocument: "before" }
  ));
  if (!claimed) {
    const existing = await files.findOne(ownerScopedQuery(String(ownerId), { _id: fileId }, "metadata.ownerId"));
    return existing ? "busy" : "missing";
  }

  try {
    const threadHasFile = await ThreadModel.exists(ownerScopedQuery(ownerId, {
      "messages.attachments.fileId": fileId
    }));
    if (threadHasFile) {
      await files.updateOne(ownerScopedQuery(String(ownerId), { _id: fileId, "metadata.lifecycleState": "deleting" }, "metadata.ownerId"), {
        $set: {
          "metadata.lifecycleState": "linked",
          "metadata.cleanupAfter": new Date(now.getTime() + UPLOAD_RETENTION_MS)
        },
        $unset: { "metadata.pendingExpiresAt": "" }
      });
      return "referenced";
    }

    await bucket.delete(fileId);
    return "deleted";
  } catch (error) {
    if (/^File not found for id\b/.test(error.message || "")) return "missing";
    const priorState = claimed.metadata?.lifecycleState || "pending";
    await files.updateOne(ownerScopedQuery(String(ownerId), { _id: fileId, "metadata.lifecycleState": "deleting" }, "metadata.ownerId"), {
      $set: {
        "metadata.lifecycleState": priorState,
        "metadata.cleanupAfter": new Date(now.getTime() + 60 * 60 * 1000)
      }
    }).catch(() => {});
    throw error;
  }
}

export async function cleanupExpiredUploads({ db, bucket, ThreadModel, now = new Date(), limit = 100 }) {
  const cutoff = new Date(now.getTime() - UPLOAD_RETENTION_MS);
  const candidates = await db.collection("images.files")
    .find({
      "metadata.generated": false,
      $or: [
        { "metadata.pendingExpiresAt": { $lte: now } },
        { "metadata.cleanupAfter": { $lte: now } },
        { "metadata.lifecycleState": { $exists: false }, uploadDate: { $lt: cutoff } }
      ]
    })
    .sort({ uploadDate: 1 })
    .limit(limit)
    .project({ _id: 1, "metadata.ownerId": 1 })
    .toArray();
  const results = { deleted: 0, preserved: 0, busy: 0, missing: 0 };
  for (const file of candidates) {
    if (!file.metadata?.ownerId) continue;
    const result = await deleteFileIfUnreferenced({
      db, bucket, ThreadModel, fileId: file._id, ownerId: file.metadata.ownerId, now
    });
    if (result === "deleted") results.deleted += 1;
    else if (result === "referenced") results.preserved += 1;
    else if (result === "busy") results.busy += 1;
    else results.missing += 1;
  }
  return results;
}

export async function cleanupOrphanedGridFSChunks({ db, bucket, now = new Date(), limit = 100 }) {
  const chunksExist = await db.listCollections({ name: "images.chunks" }, { nameOnly: true }).hasNext();
  if (!chunksExist) return 0;
  const cutoff = new Date(now.getTime() - UPLOAD_RETENTION_MS);
  const oldestEligibleId = ObjectId.createFromTime(Math.floor(cutoff.getTime() / 1000));
  const candidates = await db.collection("images.chunks").aggregate([
    { $match: { files_id: { $lt: oldestEligibleId } } },
    {
      $lookup: {
        from: "images.files",
        localField: "files_id",
        foreignField: "_id",
        as: "file"
      }
    },
    { $match: { file: { $eq: [] } } },
    { $group: { _id: "$files_id" } },
    { $limit: limit }
  ]).toArray();
  let cleaned = 0;
  for (const { _id: fileId } of candidates) {
    try {
      await bucket.delete(fileId);
      cleaned += 1;
    } catch (error) {
      // GridFS deletes chunks before reporting that the files document is missing.
      if (/^File not found for id\b/.test(error.message || "")) cleaned += 1;
      else throw error;
    }
  }
  return cleaned;
}
