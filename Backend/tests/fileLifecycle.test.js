import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { ObjectId } from "mongodb";
import { test } from "node:test";
import { writeGridFSFile } from "../utils/gridfs.js";
import {
  cleanupExpiredUploads,
  collectThreadFileIds,
  cleanupOrphanedGridFSChunks,
  deleteFileIfUnreferenced,
  formatImageGalleryItem,
  releaseFilesFromChat,
  reserveFilesForChat,
  UPLOAD_RETENTION_MS
} from "../utils/fileLifecycle.js";

const owner = "507f1f77bcf86cd799439011";
const otherOwner = "507f191e810c19729de860ea";

function fakeStore(files = []) {
  const cloneFile = (file) => ({ ...file, _id: new ObjectId(String(file._id)), uploadDate: new Date(file.uploadDate), metadata: { ...file.metadata } });
  const records = new Map(files.map((file) => [String(file._id), cloneFile(file)]));
  const calls = { deleted: [], threadQueries: [] };
  const filesCollection = {
    async findOne(query) {
      const file = records.get(String(query._id));
      return file?.metadata.ownerId === query["metadata.ownerId"] ? cloneFile(file) : null;
    },
    async findOneAndUpdate(query, update, options = {}) {
      const key = String(query._id);
      const file = records.get(key);
      if (!file || file.metadata.ownerId !== query["metadata.ownerId"]) return null;
      if (query["metadata.lifecycleState"] === "pending" && file.metadata.lifecycleState !== "pending") return null;
      if (query["metadata.lifecycleState"]?.$ne === "deleting" && file.metadata.lifecycleState === "deleting") return null;
      if (query["metadata.generated"] === false && file.metadata.generated !== false) return null;
      if (query.$or && file.metadata.activeUntil && file.metadata.activeUntil > new Date()) return null;
      const before = cloneFile(file);
      applyUpdate(file, update);
      return options.returnDocument === "before" ? before : cloneFile(file);
    },
    async updateOne(query, update) {
      const file = records.get(String(query._id));
      if (!file || file.metadata.ownerId !== query["metadata.ownerId"]) return { matchedCount: 0 };
      if (query["metadata.activeRequestId"] && file.metadata.activeRequestId !== query["metadata.activeRequestId"]) return { matchedCount: 0 };
      if (query["metadata.lifecycleState"] && file.metadata.lifecycleState !== query["metadata.lifecycleState"]) return { matchedCount: 0 };
      applyUpdate(file, update);
      return { matchedCount: 1 };
    },
    find(query) {
      calls.cleanupQuery = query;
      return {
        sort() { return this; },
        limit() { return this; },
        project() { return this; },
        async toArray() {
          const now = new Date();
          const cutoff = new Date(now.getTime() - UPLOAD_RETENTION_MS);
          return [...records.values()].filter((file) => file.metadata.generated === false && (
            file.metadata.pendingExpiresAt <= now ||
            file.metadata.cleanupAfter <= now ||
            (!file.metadata.lifecycleState && file.uploadDate < cutoff)
          ))
            .map((file) => ({ _id: new ObjectId(String(file._id)), metadata: { ownerId: file.metadata.ownerId } }));
        }
      };
    }
  };
  const db = { collection: () => filesCollection };
  const references = new Set();
  const ThreadModel = {
    async exists(query) {
      calls.threadQueries.push(query);
      assert.equal(query.ownerId, owner);
      return references.has(String(query["messages.attachments.fileId"])) ? { _id: new ObjectId() } : null;
    }
  };
  const bucket = {
    async delete(fileId) {
      calls.deleted.push(String(fileId));
      records.delete(String(fileId));
    }
  };
  return { records, calls, filesCollection, db, ThreadModel, bucket, references };
}

function applyUpdate(record, update) {
  for (const [path, value] of Object.entries(update.$set || {})) setPath(record, path, value);
  for (const path of Object.keys(update.$unset || {})) unsetPath(record, path);
  for (const [path, amount] of Object.entries(update.$inc || {})) setPath(record, path, (getPath(record, path) || 0) + amount);
}

function getPath(record, path) { return path.split(".").reduce((value, key) => value?.[key], record); }
function setPath(record, path, value) {
  const keys = path.split(".");
  const leaf = keys.pop();
  const target = keys.reduce((value, key) => value[key] ||= {}, record);
  target[leaf] = value;
}
function unsetPath(record, path) {
  const keys = path.split(".");
  const leaf = keys.pop();
  const target = keys.reduce((value, key) => value?.[key], record);
  if (target) delete target[leaf];
}

function file(ownerId = owner, metadata = {}) {
  return {
    _id: new ObjectId(),
    filename: "photo.png",
    uploadDate: new Date(Date.now() - UPLOAD_RETENTION_MS - 1000),
    metadata: {
      ownerId,
      generated: false,
      contentType: "image/png",
      lifecycleState: "pending",
      pendingExpiresAt: new Date(Date.now() - 1000),
      ...metadata
    }
  };
}

test("uploads from failed chats are released and removed if no saved message references them", async () => {
  const uploaded = file();
  const store = fakeStore([uploaded]);
  const reserved = await reserveFilesForChat({
    files: store.filesCollection, fileIds: [uploaded._id], ownerId: owner, requestId: "failed-chat", now: new Date()
  });
  assert.deepEqual(reserved.map(String), [String(uploaded._id)]);
  await releaseFilesFromChat({ files: store.filesCollection, fileIds: reserved, ownerId: owner, requestId: "failed-chat" });
  const result = await deleteFileIfUnreferenced({
    db: store.db, bucket: store.bucket, ThreadModel: store.ThreadModel, fileId: uploaded._id, ownerId: owner, pendingOnly: true
  });
  assert.equal(result, "deleted");
  assert.deepEqual(store.calls.deleted, [String(uploaded._id)]);
});

test("thread deletion cleanup preserves files referenced by other messages or threads", async () => {
  const shared = file(owner, { lifecycleState: "linked", pendingExpiresAt: undefined });
  const store = fakeStore([shared]);
  store.references.add(String(shared._id));
  assert.deepEqual(collectThreadFileIds([
    { attachments: [{ fileId: shared._id }, { fileId: shared._id }] },
    { attachments: [{ fileId: shared._id }] }
  ]), [String(shared._id)]);
  const result = await deleteFileIfUnreferenced({
    db: store.db, bucket: store.bucket, ThreadModel: store.ThreadModel, fileId: shared._id, ownerId: owner
  });
  assert.equal(result, "referenced");
  assert.equal(store.records.has(String(shared._id)), true);
  assert.deepEqual(store.calls.deleted, []);
});

test("missing files and repeated cleanup are safe and idempotent", async () => {
  const oldFile = file();
  const store = fakeStore([oldFile]);
  assert.equal(await deleteFileIfUnreferenced({ db: store.db, bucket: store.bucket, ThreadModel: store.ThreadModel, fileId: oldFile._id, ownerId: owner }), "deleted");
  assert.equal(await deleteFileIfUnreferenced({ db: store.db, bucket: store.bucket, ThreadModel: store.ThreadModel, fileId: oldFile._id, ownerId: owner }), "missing");
  assert.deepEqual(store.calls.deleted, [String(oldFile._id)]);
});

test("another user's file is never deleted, and active chat reads defer cleanup", async () => {
  const privateFile = file(otherOwner);
  const activeFile = file(owner, { activeUntil: new Date(Date.now() + 60000) });
  const store = fakeStore([privateFile, activeFile]);
  assert.equal(await deleteFileIfUnreferenced({ db: store.db, bucket: store.bucket, ThreadModel: store.ThreadModel, fileId: privateFile._id, ownerId: owner }), "missing");
  assert.equal(await deleteFileIfUnreferenced({ db: store.db, bucket: store.bucket, ThreadModel: store.ThreadModel, fileId: activeFile._id, ownerId: owner }), "busy");
  assert.deepEqual(store.calls.deleted, []);
});

test("partial reservation failure releases earlier file leases", async () => {
  const available = file();
  const store = fakeStore([available]);
  const reserved = await reserveFilesForChat({
    files: store.filesCollection,
    fileIds: [available._id, new ObjectId()],
    ownerId: owner,
    requestId: "partial-reservation"
  });
  assert.equal(reserved, false);
  assert.equal(store.records.get(String(available._id)).metadata.activeRequestId, undefined);
});

test("database and GridFS deletion failures restore the file state for later retry", async () => {
  const item = file();
  const store = fakeStore([item]);
  const failingThreadModel = { async exists() { throw new Error("database unavailable"); } };
  await assert.rejects(deleteFileIfUnreferenced({
    db: store.db, bucket: store.bucket, ThreadModel: failingThreadModel, fileId: item._id, ownerId: owner
  }), /database unavailable/);
  assert.equal(store.records.get(String(item._id)).metadata.lifecycleState, "pending");

  const failingBucket = { async delete() { throw new Error("temporary GridFS failure"); } };
  await assert.rejects(deleteFileIfUnreferenced({
    db: store.db, bucket: failingBucket, ThreadModel: store.ThreadModel, fileId: item._id, ownerId: owner
  }), /temporary GridFS failure/);
  assert.equal(store.records.get(String(item._id)).metadata.lifecycleState, "pending");
});

test("expired-upload sweep deletes abandoned uploads but retains referenced files", async () => {
  const abandoned = file();
  const retained = file(owner, { lifecycleState: "linked" });
  const store = fakeStore([abandoned, retained]);
  store.references.add(String(retained._id));
  const result = await cleanupExpiredUploads({ db: store.db, bucket: store.bucket, ThreadModel: store.ThreadModel });
  assert.deepEqual(result, { deleted: 1, preserved: 1, busy: 0, missing: 0 });
  assert.deepEqual(store.calls.deleted, [String(abandoned._id)]);
  assert.ok(store.calls.cleanupQuery.$or.length === 3);
});

test("generated gallery items expose content type from GridFS metadata", () => {
  const generated = file(owner, { generated: true, contentType: "image/png", lifecycleState: "generated" });
  const item = formatImageGalleryItem(generated);
  assert.equal(item.contentType, "image/png");
  assert.equal(item.fileId, String(generated._id));
  assert.equal(item.url, `/api/images/${generated._id}`);
});

test("old chunks without a GridFS file record are removed individually, with a bounded orphan query", async () => {
  const orphanId = ObjectId.createFromTime(Math.floor((Date.now() - UPLOAD_RETENTION_MS * 2) / 1000));
  let pipeline;
  const deletes = [];
  const db = {
    listCollections: () => ({ async hasNext() { return true; } }),
    collection: () => ({
      aggregate(value) {
        pipeline = value;
        return { async toArray() { return [{ _id: orphanId }]; } };
      }
    })
  };
  const bucket = {
    async delete(fileId) {
      deletes.push(String(fileId));
      throw new Error(`File not found for id ${fileId}`);
    }
  };
  assert.equal(await cleanupOrphanedGridFSChunks({ db, bucket, limit: 5 }), 1);
  assert.deepEqual(deletes, [String(orphanId)]);
  assert.equal(pipeline.at(-1).$limit, 5);
  assert.equal(pipeline.some((stage) => stage.$match?.file?.$eq?.length === 0), true);
});

test("failed or interrupted GridFS uploads abort and remove partial chunks", async () => {
  const id = new ObjectId();
  class MockUpload extends EventEmitter {
    constructor() { super(); this.id = id; this.abortCalled = false; }
    end() { queueMicrotask(() => this.emit("error", new Error("write failed"))); }
    async abort() { this.abortCalled = true; }
  }
  const stream = new MockUpload();
  const deleted = [];
  const bucket = {
    openUploadStream: () => stream,
    async delete(fileId) { deleted.push(String(fileId)); }
  };
  await assert.rejects(writeGridFSFile(bucket, { buffer: Buffer.from("test"), filename: "upload.png", metadata: {} }), /write failed/);
  assert.equal(stream.abortCalled, true);
  assert.deepEqual(deleted, [String(id)]);

  const interruptedStream = new MockUpload();
  interruptedStream.end = () => {};
  const interruptedBucket = {
    openUploadStream: () => interruptedStream,
    async delete(fileId) { deleted.push(String(fileId)); }
  };
  const controller = new AbortController();
  const interrupted = writeGridFSFile(interruptedBucket, {
    buffer: Buffer.from("test"), filename: "upload.png", metadata: {}, signal: controller.signal
  });
  controller.abort();
  await assert.rejects(interrupted, /This operation was aborted/);
  assert.equal(interruptedStream.abortCalled, true);
  assert.deepEqual(deleted, [String(id), String(id)]);
});
