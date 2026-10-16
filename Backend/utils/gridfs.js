export function writeGridFSFile(bucket, { buffer, filename, metadata, signal }) {
  return new Promise((resolve, reject) => {
    const stream = bucket.openUploadStream(filename.slice(0, 255), { metadata });
    let aborted = false;
    let cleanupPromise;
    const removeSignalListener = () => signal?.removeEventListener("abort", onAbort);
    const cleanupPartialUpload = () => {
      if (cleanupPromise) return cleanupPromise;
      cleanupPromise = (async () => {
        try { await stream.abort(); } catch {}
        try { await bucket.delete(stream.id); } catch (error) {
          if (!/^File not found for id\b/.test(error.message || "")) {
            console.error("Partial upload cleanup deferred", { name: error.name });
          }
        }
      })();
      return cleanupPromise;
    };
    const onError = (error) => {
      if (aborted) return;
      aborted = true;
      removeSignalListener();
      void cleanupPartialUpload().finally(() => reject(error));
    };
    const onAbort = () => {
      if (aborted) return;
      aborted = true;
      void cleanupPartialUpload().finally(() => reject(signal.reason || new Error("Upload interrupted")));
    };
    stream.on("error", onError);
    stream.once("finish", () => {
      if (aborted) return;
      removeSignalListener();
      stream.removeListener("error", onError);
      resolve(stream.id);
    });
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    stream.end(buffer);
  });
}
