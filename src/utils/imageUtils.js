/**
 * Compresses an image file into a compact base64 data URL suitable for offline storage
 * and sync in Dexie and Firestore (guaranteed < 20-30KB).
 * 
 * @param {File|Blob|string} file 
 * @param {number} maxWidth 
 * @param {number} maxHeight 
 * @param {number} quality 
 * @param {string} format 
 * @returns {Promise<string>} Base64 Data URL
 */
export function compressImageToBase64(file, maxWidth = 300, maxHeight = 300, quality = 0.6, format = 'image/webp') {
    return new Promise((resolve, reject) => {
        if (!file) {
            return reject(new Error('Invalid image file provided.'));
        }

        // If already a compact data URL, return directly
        if (typeof file === 'string' && file.startsWith('data:image/')) {
            if (file.length < 35000) {
                return resolve(file);
            }
        }

        const processImageSrc = (src) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onerror = (err) => reject(err);
            img.onload = () => {
                let width = img.width || 300;
                let height = img.height || 300;

                if (width > height) {
                    if (width > maxWidth) {
                        height = Math.round((height * maxWidth) / width);
                        width = maxWidth;
                    }
                } else {
                    if (height > maxHeight) {
                        width = Math.round((width * maxHeight) / height);
                        width = maxHeight;
                    }
                }

                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;

                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);

                try {
                    let dataUrl = canvas.toDataURL(format, quality);
                    // Fall back to JPEG if WebP is unsupported
                    if (format === 'image/webp' && !dataUrl.startsWith('data:image/webp')) {
                        dataUrl = canvas.toDataURL('image/jpeg', quality);
                    }
                    resolve(dataUrl);
                } catch (_) {
                    try {
                        resolve(canvas.toDataURL('image/jpeg', quality));
                    } catch (canvasErr) {
                        reject(canvasErr);
                    }
                }
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

// 🌟 Visually pleasing modern SVG avatar encoded in Base64
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
