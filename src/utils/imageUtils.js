import { db } from '../db/database';

/**
 * Visually pleasing modern SVG avatar encoded in Base64 (for UI rendering fallback ONLY)
 */
export const DEFAULT_AVATAR_DATA_URI = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMjggMTI4IiB3aWR0aD0iMTI4IiBoZWlnaHQ9IjEyOCI+PHJlY3Qgd2lkdGg9IjEyOCIgaGVpZ2h0PSIxMjgiIHJ4PSI2NCIgZmlsbD0iI2YxZjVmOSIvPjxjaXJjbGUgY3g9IjY0IiBjeT0iNTAiIHI9IjI0IiBmaWxsPSIjOTRhM2I4Ii8+PHBhdGggZD0iTTY0IDgyYy0yNCAwLTQyIDE2LTQyIDM0djEyaDg0di0xMmMwLTE4LTE4LTM0LTQyLTM0eiIgZmlsbD0iIzk0YTNiOCIvPjwvc3ZnPg==";

/**
 * Checks whether a value is a genuine, non-placeholder profile picture URL or Data URI.
 * Rejects empty strings, "لا توجد صورة", "غير متوفر", and DEFAULT_AVATAR_DATA_URI.
 *
 * @param {any} val
 * @returns {boolean}
 */
export function isValidProfilePic(val) {
    if (!val || typeof val !== 'string') return false;
    const trimmed = val.trim();
    if (!trimmed) return false;
    if (
        trimmed === DEFAULT_AVATAR_DATA_URI ||
        trimmed === 'لا توجد صورة' ||
        trimmed === 'غير متوفر' ||
        trimmed === 'لا يوجد' ||
        trimmed === 'null' ||
        trimmed === 'undefined'
    ) {
        return false;
    }
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
        return trimmed.length > 15;
    }
    if (trimmed.startsWith('data:image/')) {
        return trimmed.length > 100;
    }
    return false;
}

/**
 * Strict validator before overwriting `db.children` or Firestore during image optimization/repair:
 * Requires a valid, non-empty `http...` or `data:image/...` string with length > 100.
 *
 * @param {any} val
 * @returns {boolean}
 */
export function isValidPersistableImage(val) {
    if (!isValidProfilePic(val)) return false;
    const trimmed = val.trim();
    return (
        (trimmed.startsWith('http://') ||
            trimmed.startsWith('https://') ||
            trimmed.startsWith('data:image/')) &&
        trimmed.length > 100
    );
}

/**
 * Protects `profilePic` when merging two child records (e.g. Cloud vs Local in Push/Pull/Realtime sync).
 * If one record has an empty/invalid `profilePic` and the other has a valid `profilePic`,
 * ALWAYS preserves the non-empty valid `profilePic` unless `photoExplicitlyRemoved === true`.
 *
 * @param {Object|null} primaryRecord - The record taking precedence in the merge (e.g., newer record)
 * @param {Object|null} secondaryRecord - The other record (e.g., existing local or cloud record)
 * @returns {string} The protected profilePic value
 */
export function resolveProtectedProfilePic(primaryRecord, secondaryRecord) {
    if (primaryRecord?.photoExplicitlyRemoved === true) {
        return '';
    }
    const primaryPic = primaryRecord?.profilePic;
    const secondaryPic = secondaryRecord?.profilePic;

    const primaryValid = isValidProfilePic(primaryPic);
    const secondaryValid = isValidProfilePic(secondaryPic);

    if (primaryValid) {
        return primaryPic.trim();
    }
    if (secondaryValid && secondaryRecord?.photoExplicitlyRemoved !== true) {
        return secondaryPic.trim();
    }
    return '';
}

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
 * Strips any transformation parameters (like c_thumb, w_400, etc.) from a Cloudinary URL,
 * returning the pristine original asset URL.
 * 
 * Example:
 * https://res.cloudinary.com/cloud/image/upload/c_thumb,g_face,w_400,h_400,q_auto,f_auto/v1793239823/ayz2k6yy2bnb6znm0e6l.jpg
 * -> https://res.cloudinary.com/cloud/image/upload/v1793239823/ayz2k6yy2bnb6znm0e6l.jpg
 * 
 * @param {string|null} url 
 * @returns {string} Raw original Cloudinary URL
 */
export function getRawCloudinaryUrl(url) {
    if (!url || typeof url !== 'string') return url || '';
    const trimmed = url.trim();
    if (!trimmed || !trimmed.includes('res.cloudinary.com')) return trimmed;

    const uploadMarker = '/image/upload/';
    const uploadIdx = trimmed.indexOf(uploadMarker);
    if (uploadIdx === -1) return trimmed;

    const baseUrl = trimmed.substring(0, uploadIdx + uploadMarker.length);
    const path = trimmed.substring(uploadIdx + uploadMarker.length);

    // If there is a version tag (e.g. v1793239823/...), strip any transformations before it
    const vMatch = path.match(/(?:^|\/)(v\d+\/.*)$/);
    if (vMatch) {
        return `${baseUrl}${vMatch[1]}`;
    }

    // Strip any leading transformation segments if there's no version tag
    const segments = path.split('/');
    while (segments.length > 1) {
        const seg = segments[0];
        if (/^v\d+$/.test(seg)) break;
        if (
            seg.includes('c_') ||
            seg.includes('w_') ||
            seg.includes('h_') ||
            seg.includes('g_') ||
            seg.includes('q_') ||
            seg.includes('f_') ||
            seg.includes('b_') ||
            seg.includes('e_')
        ) {
            segments.shift();
        } else {
            break;
        }
    }

    return `${baseUrl}${segments.join('/')}`;
}

/**
 * Returns a clean, raw image URL for rendering in avatars without injecting
 * c_thumb,g_face onto raw/distorted Cloudinary assets.
 * 
 * @param {string|null} urlOrDataUri 
 * @returns {string} Clean URL or Data URI
 */
export function getAvatarUrl(urlOrDataUri) {
    if (!isValidProfilePic(urlOrDataUri)) {
        return DEFAULT_AVATAR_DATA_URI;
    }
    const trimmed = urlOrDataUri.trim();
    if (trimmed.includes('res.cloudinary.com')) {
        return getRawCloudinaryUrl(trimmed);
    }
    return trimmed;
}

/**
 * Creates and loads an HTML Image element with crossOrigin enabled.
 * 
 * @param {string} src 
 * @param {number} timeoutMs 
 * @returns {Promise<HTMLImageElement>}
 */
export function createLoadedImage(src, timeoutMs = 12000) {
    return new Promise((resolve, reject) => {
        if (!src || typeof src !== 'string' || !src.trim()) {
            return reject(new Error('Invalid or empty image source'));
        }
        const cleanSrc = getRawCloudinaryUrl(src);
        const img = new Image();
        img.crossOrigin = 'anonymous';
        let timer = null;

        const cleanup = () => {
            if (timer) clearTimeout(timer);
            img.onload = null;
            img.onerror = null;
        };

        timer = setTimeout(() => {
            cleanup();
            reject(new Error('Timeout loading image: ' + cleanSrc));
        }, timeoutMs);

        img.onload = () => {
            cleanup();
            resolve(img);
        };

        img.onerror = (err) => {
            cleanup();
            // Retry without crossOrigin if CORS header fails
            if (img.crossOrigin) {
                const retryImg = new Image();
                const retryTimer = setTimeout(() => reject(new Error('Retry timeout')), 8000);
                retryImg.onload = () => {
                    clearTimeout(retryTimer);
                    resolve(retryImg);
                };
                retryImg.onerror = (e2) => {
                    clearTimeout(retryTimer);
                    reject(e2 || err || new Error('Failed to load image'));
                };
                retryImg.src = cleanSrc;
                return;
            }
            reject(err || new Error('Failed to load image'));
        };

        img.src = cleanSrc;
    });
}

// ─── Face-API Model Management ───
let faceapiModule = null;
let isModelLoading = false;
let isModelLoaded = false;

export async function getFaceApi() {
    if (!faceapiModule) {
        try {
            faceapiModule = await import('@vladmandic/face-api');
        } catch (e) {
            console.warn('[face-api] Dynamic import failed:', e?.message);
        }
    }
    return faceapiModule;
}

export async function loadFaceDetectorModel() {
    if (isModelLoaded) return true;
    if (isModelLoading) {
        for (let i = 0; i < 40; i++) {
            await new Promise(r => setTimeout(r, 100));
            if (isModelLoaded) return true;
        }
    }
    isModelLoading = true;
    try {
        const faceapi = await getFaceApi();
        if (!faceapi || !faceapi.nets?.tinyFaceDetector) return false;

        // Try local offline public/models first
        try {
            await faceapi.nets.tinyFaceDetector.loadFromUri('/models');
            isModelLoaded = true;
            return true;
        } catch (_) {
            // Fallback to jsdelivr CDN
            await faceapi.nets.tinyFaceDetector.loadFromUri('https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model/');
            isModelLoaded = true;
            return true;
        }
    } catch (e) {
        console.warn('[face-api] Model initialization failed:', e?.message);
        return false;
    } finally {
        isModelLoading = false;
    }
}

/**
 * Core Smart 1:1 Face-Crop & Un-Squish Canvas Engine
 * 
 * Step 1: Detects & un-squishes vertical strip images (rawRatio < 0.55) to natural 0.72 portrait ratio.
 * Step 2: Detects face on the un-squished canvas using @vladmandic/face-api or window.FaceDetector.
 * Step 3: Skin-Tone & Contrast Pixel Scanner fallback if AI finds no bounding box (ignoring sky B >= R - 10, zooming in on face cluster).
 * Step 4: Draws 1:1 cropped square into targetSize x targetSize canvas and compresses <= 30,000 chars.
 * 
 * @param {HTMLImageElement|HTMLCanvasElement} imgElement 
 * @param {number} targetSize 
 * @param {string} format 
 * @param {number} quality 
 * @returns {Promise<string>} Base64 Data URL (length <= 30,000, strict 1:1 square)
 */
export async function cropAndNormalizeAvatar(imgElement, targetSize = 350, format = 'image/webp', quality = 0.65) {
    if (!imgElement) {
        throw new Error('No image element provided to cropAndNormalizeAvatar');
    }

    const naturalW = imgElement.naturalWidth || imgElement.width || targetSize;
    const naturalH = imgElement.naturalHeight || imgElement.height || targetSize;
    const rawRatio = naturalH > 0 ? naturalW / naturalH : 1;

    let source = imgElement;
    let sourceWidth = naturalW;
    let sourceHeight = naturalH;

    // ─── Step 1: Un-Squish Horizontally Distorted Vertical Strips ───
    if (rawRatio < 0.55) {
        const restoredHeight = Math.min(naturalH, 1200);
        const restoredWidth = Math.round(restoredHeight * 0.72);

        const intermediateCanvas = document.createElement('canvas');
        intermediateCanvas.width = restoredWidth;
        intermediateCanvas.height = restoredHeight;
        const iCtx = intermediateCanvas.getContext('2d');
        iCtx.fillStyle = '#FFFFFF';
        iCtx.fillRect(0, 0, restoredWidth, restoredHeight);
        iCtx.drawImage(imgElement, 0, 0, restoredWidth, restoredHeight);

        source = intermediateCanvas;
        sourceWidth = restoredWidth;
        sourceHeight = restoredHeight;
    }

    // ─── Step 2: Detect Face on the Restored Canvas (AI Models) ───
    let faceBox = null;

    try {
        const faceapi = await getFaceApi();
        if (faceapi) {
            const hasModel = await loadFaceDetectorModel();
            if (hasModel) {
                const detection = await faceapi.detectSingleFace(
                    source,
                    new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.2 })
                );
                if (detection && detection.box) {
                    faceBox = {
                        x: detection.box.x,
                        y: detection.box.y,
                        width: detection.box.width,
                        height: detection.box.height
                    };
                }
            }
        }
    } catch (aiErr) {
        console.warn('[cropAndNormalizeAvatar] AI detection note:', aiErr?.message);
    }

    // Try native window.FaceDetector if face-api didn't return a box
    if (!faceBox && typeof window !== 'undefined' && 'FaceDetector' in window) {
        try {
            const detector = new window.FaceDetector({ fastMode: true, maxDetectedFaces: 1 });
            const faces = await detector.detect(source);
            if (faces && faces.length > 0) {
                const b = faces[0].boundingBox;
                faceBox = { x: b.x, y: b.y, width: b.width, height: b.height };
            }
        } catch (_) {}
    }

    let sSize = Math.min(sourceWidth, sourceHeight);
    let sx = 0;
    let sy = 0;

    if (faceBox) {
        const cx = faceBox.x + faceBox.width / 2;
        const cy = faceBox.y + faceBox.height / 2;
        // Frame head & shoulders comfortably:
        sSize = Math.min(sourceWidth, sourceHeight, Math.max(faceBox.width, faceBox.height) * 2.8);
        sx = Math.round(cx - sSize / 2);
        sy = Math.round(cy - sSize / 2);
    } else {
        // ─── Step 3: Smart Skin-Tone & Contrast Pixel Scanner Fallback ───
        let scanCanvas = source;
        if (!(source instanceof HTMLCanvasElement)) {
            scanCanvas = document.createElement('canvas');
            scanCanvas.width = sourceWidth;
            scanCanvas.height = sourceHeight;
            const sCtx = scanCanvas.getContext('2d');
            sCtx.drawImage(source, 0, 0, sourceWidth, sourceHeight);
        }

        const sCtx = scanCanvas.getContext('2d');
        let bestY = rawRatio < 0.48 ? Math.round(sourceHeight * 0.50) : Math.round(sourceHeight * 0.35);
        let bestX = Math.round(sourceWidth * 0.50);

        try {
            const minX = Math.round(sourceWidth * 0.20);
            const maxX = Math.round(sourceWidth * 0.80);
            const minY = Math.round(sourceHeight * 0.12);
            const maxY = Math.round(sourceHeight * 0.70);

            const scanW = maxX - minX;
            const scanH = maxY - minY;

            if (scanW > 0 && scanH > 0) {
                const imgData = sCtx.getImageData(minX, minY, scanW, scanH);
                const data = imgData.data;

                const bucketHeight = 8;
                const bucketCount = Math.ceil(scanH / bucketHeight);
                const bucketScores = new Float32Array(bucketCount);
                const bucketContrast = new Float32Array(bucketCount);
                const bucketXSum = new Float64Array(bucketCount);
                const bucketCountPerB = new Int32Array(bucketCount);

                for (let y = 0; y < scanH; y += 2) {
                    const bIdx = Math.floor(y / bucketHeight);
                    for (let x = 0; x < scanW; x += 2) {
                        const i = (y * scanW + x) * 4;
                        const r = data[i];
                        const g = data[i + 1];
                        const b = data[i + 2];

                        // Ignore blue sky or water: B >= R - 10
                        if (b >= r - 10) continue;

                        // Warm human skin-tone condition:
                        const isSkin = (r > 95 && g > 40 && b > 20 && r > g && r > b && (r - b) > 15);
                        if (isSkin) {
                            bucketScores[bIdx] += 1;
                            bucketXSum[bIdx] += (minX + x);
                            bucketCountPerB[bIdx] += 1;
                        } else if (r < 65 && g < 65 && b < 65) {
                            // Dark hair/eyebrow contrast
                            bucketContrast[bIdx] += 0.5;
                        }
                    }
                }

                let maxScore = 0;
                let bestBIdx = -1;

                for (let b = 1; b < bucketCount - 1; b++) {
                    const skinTotal = bucketScores[b - 1] + bucketScores[b] * 2 + bucketScores[b + 1];
                    const contrastTotal = bucketContrast[b - 1] + bucketContrast[b] + bucketContrast[b + 1];
                    const windowScore = skinTotal > 10 ? skinTotal + Math.min(contrastTotal, skinTotal * 0.5) : skinTotal;
                    if (windowScore > maxScore) {
                        maxScore = windowScore;
                        bestBIdx = b;
                    }
                }

                if (bestBIdx !== -1 && maxScore > 20) {
                    bestY = minY + bestBIdx * bucketHeight;
                    if (bucketCountPerB[bestBIdx] > 0) {
                        bestX = Math.round(bucketXSum[bestBIdx] / bucketCountPerB[bestBIdx]);
                    }
                }
            }
        } catch (scanErr) {
            console.warn('[cropAndNormalizeAvatar] Pixel scanner note:', scanErr?.message);
        }

        // For full-body squished strips, zoom in (55% of width) centered on face cluster
        if (rawRatio < 0.48) {
            sSize = Math.round(sourceWidth * 0.55);
        } else {
            sSize = Math.min(sourceWidth, sourceHeight);
        }

        sx = Math.round(bestX - sSize / 2);
        sy = Math.round(bestY - sSize / 2);
    }

    // ─── Step 4: Draw 1:1 Square & Compress <= 30000 Chars ───
    sx = Math.max(0, Math.min(sourceWidth - sSize, sx));
    sy = Math.max(0, Math.min(sourceHeight - sSize, sy));

    const finalCanvas = document.createElement('canvas');
    finalCanvas.width = targetSize;
    finalCanvas.height = targetSize;
    const ctx = finalCanvas.getContext('2d');
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, targetSize, targetSize);
    ctx.drawImage(source, sx, sy, sSize, sSize, 0, 0, targetSize, targetSize);

    const sizeSteps = [targetSize, 280, 240, 200, 160, 120];
    const qualitySteps = [quality, 0.55, 0.45, 0.35, 0.25];

    let chosenResult = null;

    for (const curSize of sizeSteps) {
        let outCanvas = finalCanvas;
        if (curSize !== targetSize) {
            outCanvas = document.createElement('canvas');
            outCanvas.width = curSize;
            outCanvas.height = curSize;
            const oCtx = outCanvas.getContext('2d');
            oCtx.fillStyle = '#FFFFFF';
            oCtx.fillRect(0, 0, curSize, curSize);
            oCtx.drawImage(finalCanvas, 0, 0, curSize, curSize);
        }

        for (const q of qualitySteps) {
            let dataUrl = '';
            try {
                dataUrl = outCanvas.toDataURL(format, q);
                if (format === 'image/webp' && !dataUrl.startsWith('data:image/webp')) {
                    dataUrl = outCanvas.toDataURL('image/jpeg', q);
                }
            } catch {
                try {
                    dataUrl = outCanvas.toDataURL('image/jpeg', q);
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
        const minCanvas = document.createElement('canvas');
        minCanvas.width = 60;
        minCanvas.height = 60;
        const mCtx = minCanvas.getContext('2d');
        mCtx.fillStyle = '#FFFFFF';
        mCtx.fillRect(0, 0, 60, 60);
        mCtx.drawImage(finalCanvas, 0, 0, 60, 60);
        chosenResult = minCanvas.toDataURL('image/jpeg', 0.2);
    }

    return chosenResult;
}

/**
 * Compresses an image file or Data URI into a strictly 1:1 square, face-centered
 * Base64 data URL guaranteed to be under 30,000 characters.
 * 
 * @param {File|Blob|string} file 
 * @param {number} maxWidth 
 * @param {number} maxHeight 
 * @param {number} quality 
 * @param {string} format 
 * @returns {Promise<string>} Base64 Data URL (length <= 30000, 1:1 square)
 */
export async function compressImageToBase64(file, maxWidth = 350, maxHeight = 350, quality = 0.65, format = 'image/webp') {
    if (!file) {
        throw new Error('Invalid image file provided.');
    }

    const targetSize = Math.min(maxWidth, maxHeight, 350);

    let src = '';
    if (typeof file === 'string') {
        src = file;
    } else if (file instanceof Blob) {
        src = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onerror = reject;
            reader.onload = (e) => resolve(e.target.result);
            reader.readAsDataURL(file);
        });
    } else {
        throw new Error('Unsupported file input type.');
    }

    const img = await createLoadedImage(src);
    return await cropAndNormalizeAvatar(img, targetSize, format, quality);
}

/**
 * Ensures an image string is safe for Excel cell limits (< 32,767 chars)
 * and normalized to a 1:1 square.
 *
 * CRITICAL DATA PROTECTION GUARANTEE:
 * - If loading/decoding fails (network error, CORS, timeout, or decode failure),
 *   NEVER returns `""` or `DEFAULT_AVATAR_DATA_URI` and NEVER overwrites `db.children` with an empty `profilePic`.
 * - Always returns the original `dataUriOrUrl` untouched if any step of canvas loading/cropping fails.
 * - ONLY writes back to `db.children` / `db.servants` if the new image is a valid, non-empty
 *   `http...` or `data:image/...` string with length > 100.
 * 
 * @param {string} dataUriOrUrl - The image URL or Base64 Data URI
 * @param {Object|string|number} [entityInfo] - Optional { id, table: 'children'|'servants' } or id
 * @returns {Promise<string>} Valid image string
 */
export async function ensureExcelSafeImage(dataUriOrUrl, entityInfo = null) {
    if (!dataUriOrUrl || typeof dataUriOrUrl !== 'string') {
        return dataUriOrUrl;
    }

    const trimmed = dataUriOrUrl.trim();
    if (!trimmed) {
        return dataUriOrUrl;
    }

    // Do not attempt to decode placeholder strings or default SVG avatar
    if (
        trimmed === DEFAULT_AVATAR_DATA_URI ||
        trimmed === 'لا توجد صورة' ||
        trimmed === 'غير متوفر'
    ) {
        return dataUriOrUrl;
    }

    // 1. If HTTP/HTTPS URL, return clean raw URL untouched
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
        const rawUrl = getRawCloudinaryUrl(trimmed);
        return rawUrl || dataUriOrUrl;
    }

    // If not a data URL, return original untouched
    if (!trimmed.startsWith('data:image/') && !trimmed.startsWith('data:application/')) {
        return dataUriOrUrl;
    }

    // 2. Base64 inspection and normalization
    try {
        const img = await createLoadedImage(trimmed);
        const nw = img.naturalWidth || img.width || 0;
        const nh = img.naturalHeight || img.height || 0;
        const rawRatio = nh > 0 ? nw / nh : 1;

        const isSquished = rawRatio < 0.55;
        const isNonSquare = rawRatio < 0.95 || rawRatio > 1.05;
        const isTooLong = trimmed.length > 30000;

        if (!isSquished && !isNonSquare && !isTooLong) {
            return dataUriOrUrl;
        }

        const optimizedBase64 = await cropAndNormalizeAvatar(img, 300);

        // Strictly validate that the new image is a valid non-empty http... or data:image/... string with length > 100
        if (!isValidPersistableImage(optimizedBase64)) {
            console.warn('⚠️ [ensureExcelSafeImage] Cropped output did not pass validity check; preserving original image.');
            return dataUriOrUrl;
        }

        if (entityInfo) {
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
                        updatedAt: Date.now()
                    });
                } catch (dbErr) {
                    console.warn(`[ensureExcelSafeImage] Could not update ${targetTable}:${targetId} in DB:`, dbErr?.message);
                }
            }
        }

        return optimizedBase64;

    } catch (err) {
        console.warn('⚠️ [ensureExcelSafeImage] Failed to decode image into canvas; preserving original untouched:', err?.message);
        // CRITICAL: Always return the original dataUriOrUrl untouched on any error!
        return dataUriOrUrl;
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

/**
 * 3. Force-Repair ALL Existing Database & Cloudinary Images
 * 
 * - Cleans any previous c_thumb URL transformations first using getRawCloudinaryUrl to load raw asset.
 * - Detects non-square (rawRatio < 0.95 || rawRatio > 1.05) or c_thumb-affected or squished images.
 * - Un-squishes and AI face-crops to 1:1 square with head/face zoom using cropAndNormalizeAvatar(img, 350).
 * - Uploads the clean 1:1 image to Cloudinary (falling back to < 30,000 char Base64 string).
 * - ONLY writes back to db.children, db.servants, and Firestore if the new image is a valid, non-empty
 *   `http...` or `data:image/...` string with length > 100. Never overwrites with an empty or placeholder image!
 * 
 * @param {Function} [onProgress] - ({ current, total, repairedCount, currentName, status }) => void
 * @param {boolean} [forceRepair=true]
 * @returns {Promise<{ total: number, repairedCount: number }>}
 */
export async function repairAllExistingImages(onProgress = null, forceRepair = true) {
    const { uploadImageToCloudinary } = await import('./cloudinary');
    const { firestore } = await import('../db/firebase');
    const { doc, setDoc } = await import('firebase/firestore');

    const allKids = (await db.children?.toArray()) || [];
    const kidsToProcess = allKids.filter(k => isValidProfilePic(k.profilePic) && !k.isDeleted);

    const allServants = (await db.servants?.toArray()) || [];
    const servantsToProcess = allServants.filter(
        s => isValidProfilePic(s.profilePic || s.photoURL || s.profileImage) && !s.isDeleted
    );

    const total = kidsToProcess.length + servantsToProcess.length;
    let processed = 0;
    let repairedCount = 0;

    if (onProgress) {
        onProgress({ current: 0, total, repairedCount, currentName: '', status: 'starting' });
    }

    const processItem = async (item, type = 'child') => {
        const originalPic = item.profilePic || item.photoURL || item.profileImage;
        if (!isValidProfilePic(originalPic)) {
            processed++;
            return;
        }

        // Always strip transformations first to load the pristine RAW asset
        const rawCleanUrl = getRawCloudinaryUrl(originalPic);

        if (onProgress) {
            onProgress({ current: processed + 1, total, repairedCount, currentName: item.name || '', status: 'processing' });
        }

        try {
            const img = await createLoadedImage(rawCleanUrl);
            const nw = img.naturalWidth || img.width || 0;
            const nh = img.naturalHeight || img.height || 0;
            const rawRatio = nh > 0 ? nw / nh : 1;

            const isNonSquare = rawRatio < 0.95 || rawRatio > 1.05;
            const hasCThumb = originalPic.includes('c_thumb');
            const isTooLong = typeof originalPic === 'string' && originalPic.length > 31000;

            if (forceRepair || isNonSquare || hasCThumb || isTooLong) {
                // Un-squish, AI face-detect & zoom 1:1 crop
                const squareDataUri = await cropAndNormalizeAvatar(img, 350);

                // Ensure the cropped base64 itself is valid (>100 chars, data:image/...)
                if (!isValidPersistableImage(squareDataUri)) {
                    console.warn(`[repairAllExistingImages] Skipping write for ${item.name}: cropped image failed validation.`);
                    return;
                }

                let finalUrl = squareDataUri;
                if (navigator.onLine) {
                    try {
                        const uploaded = await uploadImageToCloudinary(squareDataUri, 'image');
                        if (uploaded) {
                            const cleanedUploaded = getRawCloudinaryUrl(uploaded);
                            if (isValidPersistableImage(cleanedUploaded)) {
                                finalUrl = cleanedUploaded;
                            }
                        }
                    } catch (uploadErr) {
                        console.warn(`[repairAllExistingImages] Cloudinary upload fallback for ${item.name}:`, uploadErr?.message);
                    }
                }

                // Final safety gate: NEVER write back unless finalUrl is a valid http... or data:image/... with length > 100
                if (!isValidPersistableImage(finalUrl)) {
                    console.warn(`[repairAllExistingImages] Refusing to overwrite ${item.name} with invalid image.`);
                    return;
                }

                const now = Date.now();

                if (type === 'child') {
                    await db.children.update(item.id, {
                        profilePic: finalUrl,
                        isDirty: true,
                        updatedAt: now
                    });

                    // Strictly write only to the child's own syncKey
                    const targetKey = item.syncKey && item.syncKey !== 'MASTER_ACCESS' && item.syncKey !== 'ADMIN_MODE' && item.syncKey !== 'STAGE_ADMIN'
                        ? item.syncKey
                        : null;

                    if (navigator.onLine && firestore && targetKey) {
                        try {
                            await setDoc(doc(firestore, 'Osras', targetKey, 'children', String(item.id)), {
                                profilePic: finalUrl,
                                updatedAt: now
                            }, { merge: true });
                        } catch (fsErr) {
                            console.warn(`[repairAllExistingImages] Firestore update failed for ${item.name}:`, fsErr?.message);
                        }
                    }
                } else {
                    await db.servants.update(item.id, {
                        profilePic: finalUrl,
                        isDirty: true,
                        updatedAt: now
                    });
                }

                repairedCount++;
            }
        } catch (err) {
            console.warn(`[repairAllExistingImages] Skipping image for ${item.name} (${item.id}) — preserving original:`, err?.message);
        } finally {
            processed++;
            if (onProgress) {
                onProgress({ current: processed, total, repairedCount, currentName: item.name || '', status: 'progress' });
            }
        }
    };

    for (const kid of kidsToProcess) {
        await processItem(kid, 'child');
    }

    for (const servant of servantsToProcess) {
        await processItem(servant, 'servant');
    }

    if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('children-updated'));
        window.dispatchEvent(new CustomEvent('servant-updated'));
    }

    if (onProgress) {
        onProgress({ current: total, total, repairedCount, currentName: '', status: 'finished' });
    }

    return { total, repairedCount };
}
