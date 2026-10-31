import { db } from '../db/database';

/**
 * Visually pleasing modern SVG avatar encoded in Base64
 */
export const DEFAULT_AVATAR_DATA_URI = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMjggMTI4IiB3aWR0aD0iMTI4IiBoZWlnaHQ9IjEyOCI+PHJlY3Qgd2lkdGg9IjEyOCIgaGVpZ2h0PSIxMjgiIHJ4PSI2NCIgZmlsbD0iI2YxZjVmOSIvPjxjaXJjbGUgY3g9IjY0IiBjeT0iNTAiIHI9IjI0IiBmaWxsPSIjOTRhM2I4Ii8+PHBhdGggZD0iTTY0IDgyYy0yNCAwLTQyIDE2LTQyIDM0djEyaDg0di0xMmMwLTE4LTE4LTM0LTQyLTM0eiIgZmlsbD0iIzk0YTNiOCIvPjwvc3ZnPg==";

/**
 * Handles image loading errors gracefully by substituting a visually pleasing default avatar
 * and preventing infinite onError loops. Never hides the layout with display: 'none'.
 * 
 * @param {Event} e - The image onError event
 * @param {string|null} fallback - Optional fallback image URL / data URI
 */
export function handleImageError(e, fallback = DEFAULT_AVATAR_DATA_URI) {
    if (e?.target) {
        e.target.onerror = null; // Prevent infinite error loops
        const replacement = fallback || DEFAULT_AVATAR_DATA_URI;
        if (e.target.src !== replacement) {
            e.target.src = replacement;
        }
        if (e.target.style && e.target.style.display === 'none') {
            e.target.style.display = '';
        }
    }
}

/**
 * Compresses an image file or Data URI into a compact base64 data URL guaranteed to be
 * under 30,000 characters, making it completely safe for Excel cell limits (32,767 chars)
 * and ideal for offline storage in Dexie and Firestore sync.
 * 
 * @param {File|Blob|string} file 
 * @param {number} maxWidth 
 * @param {number} maxHeight 
 * @param {number} quality 
 * @param {string} format 
 * @returns {Promise<string>} Base64 Data URL (length <= 30000)
 */
export function compressImageToBase64(file, maxWidth = 260, maxHeight = 260, quality = 0.6, format = 'image/webp') {
    return new Promise((resolve, reject) => {
        if (!file) {
            return reject(new Error('Invalid image file provided.'));
        }

        // If already a compact data URL under 30,000 characters, return directly
        if (typeof file === 'string' && file.startsWith('data:image/')) {
            if (file.length <= 30000) {
                return resolve(file);
            }
        }

        const processImageSrc = (src) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onerror = (err) => reject(err);
            img.onload = () => {
                const originalWidth = img.naturalWidth || img.width || 300;
                const originalHeight = img.naturalHeight || img.height || 300;

                const dimensionSteps = [
                    Math.min(maxWidth, 240),
                    200,
                    170,
                    140,
                    110,
                    90,
                    70,
                    50
                ];
                const qualitySteps = [Math.min(quality, 0.6), 0.52, 0.42, 0.35, 0.25];

                let chosenResult = null;

                for (const dim of dimensionSteps) {
                    let width = originalWidth;
                    let height = originalHeight;

                    if (width > height) {
                        if (width > dim) {
                            height = Math.round((height * dim) / width);
                            width = dim;
                        }
                    } else {
                        if (height > dim) {
                            width = Math.round((width * dim) / height);
                            height = dim;
                        }
                    }
                    width = Math.max(width, 1);
                    height = Math.max(height, 1);

                    const canvas = document.createElement('canvas');
                    canvas.width = width;
                    canvas.height = height;
                    const ctx = canvas.getContext('2d');
                    ctx.fillStyle = '#FFFFFF';
                    ctx.fillRect(0, 0, width, height);
                    ctx.drawImage(img, 0, 0, width, height);

                    for (const q of qualitySteps) {
                        let dataUrl = '';
                        try {
                            dataUrl = canvas.toDataURL(format, q);
                            if (format === 'image/webp' && !dataUrl.startsWith('data:image/webp')) {
                                dataUrl = canvas.toDataURL('image/jpeg', q);
                            }
                        } catch {
                            try {
                                dataUrl = canvas.toDataURL('image/jpeg', q);
                            } catch {
                                dataUrl = '';
                            }
                        }

                        if (dataUrl && dataUrl.length <= 30000) {
                            chosenResult = dataUrl;
                            break;
                        }
                    }

                    if (chosenResult) break;
                }

                if (!chosenResult) {
                    // Fallback to minimal 50x50 JPEG
                    try {
                        const canvas = document.createElement('canvas');
                        canvas.width = 50;
                        canvas.height = 50;
                        const ctx = canvas.getContext('2d');
                        ctx.fillStyle = '#FFFFFF';
                        ctx.fillRect(0, 0, 50, 50);
                        ctx.drawImage(img, 0, 0, 50, 50);
                        chosenResult = canvas.toDataURL('image/jpeg', 0.2);
                    } catch (e) {
                        return reject(e);
                    }
                }

                resolve(chosenResult);
            };
            img.src = src;
        };

        if (typeof file === 'string') {
            processImageSrc(file);
        } else if (file instanceof Blob) {
            const reader = new FileReader();
            reader.onerror = (err) => reject(err);
            reader.onload = (e) => processImageSrc(e.target.result);
            reader.readAsDataURL(file);
        } else {
            reject(new Error('Unsupported file input type.'));
        }
    });
}

/**
 * Ensures an image string (URL or Base64 Data URI) is safe for Excel cell limits (< 32,767 chars).
 * - If empty, HTTP/HTTPS URL, or <= 31,000 characters, returns as-is immediately.
 * - If > 31,000 characters, decodes into an HTML5 <canvas> and progressively downscales & compresses
 *   until length <= 30,000 while remaining a 100% valid image.
 * - Saves the optimized Base64 back to db.children / db.servants so future exports are instant.
 * 
 * @param {string} dataUriOrUrl - The image URL or Base64 Data URI
 * @param {Object|string|number} [entityInfo] - Optional { id, table: 'children'|'servants' } or id
 * @returns {Promise<string>} Valid image string <= 30,000 chars
 */
export async function ensureExcelSafeImage(dataUriOrUrl, entityInfo = null) {
    if (!dataUriOrUrl || typeof dataUriOrUrl !== 'string') {
        return dataUriOrUrl || '';
    }

    const trimmed = dataUriOrUrl.trim();
    if (!trimmed) {
        return '';
    }

    // 1. If HTTP/HTTPS URL or already <= 31,000 chars, return immediately
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
        return trimmed;
    }

    if (trimmed.length <= 31000) {
        return trimmed;
    }

    // If not a data URL and doesn't look like base64, cap length safely
    if (!trimmed.startsWith('data:image/') && !trimmed.startsWith('data:application/')) {
        return trimmed.slice(0, 30000);
    }

    // 2. Offscreen image loading & progressive compression
    try {
        const img = await new Promise((resolve, reject) => {
            const image = new Image();
            image.crossOrigin = 'anonymous';
            image.onload = () => resolve(image);
            image.onerror = (e) => reject(new Error('Failed to load image into canvas: ' + (e?.message || 'invalid image data')));
            image.src = trimmed;
        });

        const originalWidth = img.naturalWidth || img.width || 300;
        const originalHeight = img.naturalHeight || img.height || 300;

        const dimensionSteps = [220, 180, 150, 120, 100, 80, 60];
        const qualitySteps = [0.6, 0.5, 0.4, 0.35, 0.28, 0.2];

        let optimizedBase64 = null;

        for (const maxDim of dimensionSteps) {
            let width = originalWidth;
            let height = originalHeight;

            if (width > height) {
                if (width > maxDim) {
                    height = Math.round((height * maxDim) / width);
                    width = maxDim;
                }
            } else {
                if (height > maxDim) {
                    width = Math.round((width * maxDim) / height);
                    height = maxDim;
                }
            }

            width = Math.max(width, 1);
            height = Math.max(height, 1);

            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#FFFFFF';
            ctx.fillRect(0, 0, width, height);
            ctx.drawImage(img, 0, 0, width, height);

            for (const q of qualitySteps) {
                let dataUrl = '';
                try {
                    dataUrl = canvas.toDataURL('image/webp', q);
                    if (!dataUrl.startsWith('data:image/webp')) {
                        dataUrl = canvas.toDataURL('image/jpeg', q);
                    }
                } catch {
                    try {
                        dataUrl = canvas.toDataURL('image/jpeg', q);
                    } catch {
                        dataUrl = '';
                    }
                }

                if (dataUrl && dataUrl.length <= 30000) {
                    optimizedBase64 = dataUrl;
                    break;
                }
            }

            if (optimizedBase64) break;
        }

        // Final safety net: tiny JPEG 50x50
        if (!optimizedBase64 || optimizedBase64.length > 30000) {
            const canvas = document.createElement('canvas');
            canvas.width = 50;
            canvas.height = 50;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#FFFFFF';
            ctx.fillRect(0, 0, 50, 50);
            ctx.drawImage(img, 0, 0, 50, 50);
            optimizedBase64 = canvas.toDataURL('image/jpeg', 0.2);
        }

        // 3. Bonus: Persist newly optimized Base64 back to IndexedDB (db.children or db.servants)
        if (optimizedBase64 && entityInfo) {
            let targetId = null;
            let targetTable = 'children';

            if (typeof entityInfo === 'string' || typeof entityInfo === 'number') {
                targetId = entityInfo;
            } else if (typeof entityInfo === 'object') {
                targetId = entityInfo.id;
                if (entityInfo.table) {
                    targetTable = entityInfo.table;
                } else if (entityInfo.type === 'servant') {
                    targetTable = 'servants';
                }
            }

            if (targetId && db && db[targetTable]) {
                try {
                    await db[targetTable].update(targetId, {
                        profilePic: optimizedBase64,
                        isDirty: true,
                        updatedAt: new Date().toISOString()
                    });
                } catch (dbErr) {
                    console.warn(`[ensureExcelSafeImage] Could not update ${targetTable}:${targetId} in DB:`, dbErr?.message);
                }
            }
        }

        return optimizedBase64;

    } catch (err) {
        console.warn('⚠️ [ensureExcelSafeImage] Failed to decode image into canvas:', err?.message);
        // If image loading fails, return default avatar or safe capped string so Excel never crashes
        if (trimmed.startsWith('data:image/')) {
            return DEFAULT_AVATAR_DATA_URI;
        }
        return trimmed.slice(0, 30000);
    }
}

/**
 * Safely caps any non-image string cell at 32,000 characters to comply with Excel cell limit (32,767 chars),
 * while keeping valid image strings untouched.
 * 
 * @param {Object} row 
 * @param {string} [imageKey="رابط الصورة المرفوعة"] 
 * @returns {Object} Clean row
 */
export function sanitizeExcelRow(row, imageKey = "رابط الصورة المرفوعة") {
    const cleanRow = {};
    for (const [key, val] of Object.entries(row)) {
        if (typeof val === 'string') {
            if (key === imageKey) {
                // Ensure image does not exceed Excel's limit just in case
                cleanRow[key] = val.length > 32000 ? val.slice(0, 32000) : val;
            } else if (val.length > 32000) {
                cleanRow[key] = val.slice(0, 32000);
            } else {
                cleanRow[key] = val;
            }
        } else {
            cleanRow[key] = val;
        }
    }
    return cleanRow;
}
