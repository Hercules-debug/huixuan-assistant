/**
 * 商品图获取与附件登记
 *
 * 设计要点：
 *  1. **best-effort** —— 图片失败绝不能让商品查询失败。任何异常都返回 null，
 *     调用方按「没有图」继续渲染文本结果。
 *  2. **只在详情/对比阶段调用** —— 搜索结果一页 15~40 条，逐条下载图片会产生
 *     同量级网络请求，显著增加延迟与流量。见 lib/index.js 里 shop_search 的实现。
 *  3. **大小与超时上限** —— 第三方图床不可控，必须自己设边界。
 *  4. **按魔数嗅探媒体类型** —— `saveImage` 会用真实字节校验声明的类型，
 *     声错会直接抛错，所以不能只信 URL 后缀。
 *
 * 参考实现：@deepseek-ai/dsh-mcp-client 的图片准入流程
 * （`resolveImageAdmission` → `attachments.saveImages` → `{type:'image', attachment}`），
 * 它在失败时同样降级为文本诊断，而不是让整个工具调用失败。
 */

/** 单张图片最大字节数（超出则跳过，不阻断） */
const MAX_IMAGE_BYTES = 3 * 1024 * 1024; // 3MB

/** 下载超时 */
const FETCH_TIMEOUT_MS = 8000;

/** 附件服务支持的媒体类型 */
const ALLOWED_MEDIA_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/webp', 'image/gif',
]);

/**
 * 按魔数嗅探图片媒体类型。
 * @param {Uint8Array} bytes
 * @returns {string | null} 支持的媒体类型，或 null（不是受支持的图片）
 */
export function sniffImageMediaType(bytes) {
  if (bytes.length < 12) return null;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png';
  }
  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  // GIF: "GIF8"
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return 'image/gif';
  }
  // WebP: "RIFF" .... "WEBP"
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
      && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return 'image/webp';
  }
  return null;
}

/**
 * 下载一张商品图并登记为附件。
 *
 * @param {object} opts
 * @param {string} opts.url - 图片地址（来自拼多多商品数据）
 * @param {object} opts.attachments - DSH 的 AttachmentStore 服务（ctx.attachments）
 * @param {string} [opts.name] - 展示名
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<object|null>} ImageAttachmentRef，或 null（失败/不受支持）
 */
export async function fetchImageAttachment({ url, attachments, name, signal }) {
  if (!url || !attachments?.saveImage) return null;

  let bytes;
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
    if (signal) {
      if (signal.aborted) return null;
      signal.addEventListener('abort', () => ac.abort(), { once: true });
    }
    let res;
    try {
      res = await fetch(url, { signal: ac.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return null;

    // 先看 Content-Length，避免把超大文件读进内存
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > MAX_IMAGE_BYTES) return null;

    const buf = await res.arrayBuffer();
    if (buf.byteLength === 0 || buf.byteLength > MAX_IMAGE_BYTES) return null;
    bytes = new Uint8Array(buf);
  } catch {
    return null; // 网络/超时/中止 —— 一律降级为「没有图」
  }

  const mediaType = sniffImageMediaType(bytes);
  if (mediaType === null || !ALLOWED_MEDIA_TYPES.has(mediaType)) return null;

  try {
    const ref = await attachments.saveImage({
      data: bytes,
      mediaType,
      ...(name ? { name } : {}),
    });
    if (!ref?.attachmentId) return null;
    // 只保留 schema 声明过的字段（originalDimensions 等一律剔除，
    // 否则会与 output.schema 的 additionalProperties:false 冲突）
    return {
      attachmentId: String(ref.attachmentId),
      mediaType: ref.mediaType,
      bytes: ref.bytes,
      width: ref.width,
      height: ref.height,
      ...(ref.name ? { name: ref.name } : {}),
    };
  } catch {
    return null; // 登记失败同样降级
  }
}

/**
 * 供输出 schema 复用的附件引用结构。
 *
 * ⚠️ 必须与 ImageAttachmentRef 的可序列化字段一致：
 * `saveImage` 返回的 originalDimensions 是可选嵌套对象，
 * 这里刻意不声明，并在 fetchImageAttachment 里剔除，避免 schema 冲突。
 */
export const ATTACHMENT_REF_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    attachmentId: { type: 'string', required: true },
    mediaType: { type: 'string', required: true },
    bytes: { type: 'integer', required: true },
    width: { type: 'integer', required: true },
    height: { type: 'integer', required: true },
    name: { type: 'string' },
  },
};
