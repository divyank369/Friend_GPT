const imageReference = /\b(image|photo|picture|screenshot|visual)\b/i;

export function selectModelAttachmentIds(message, history = [], suppliedIds = [], limit = 3) {
  const priorImageIds = imageReference.test(message)
    ? history.slice(-20).reverse().flatMap((entry) => (entry.attachments || [])
      .filter((attachment) => attachment.contentType?.startsWith("image/"))
      .map((attachment) => String(attachment.fileId)).reverse())
    : [];
  return [...new Set([...suppliedIds, ...priorImageIds])].slice(0, limit);
}
