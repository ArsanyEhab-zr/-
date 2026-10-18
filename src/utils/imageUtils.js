/**
 * Compresses an image file into a compact base64 data URL suitable for offline storage
 * and sync in Dexie and Firestore (typically < 40KB).
 * 
 * @param {File|Blob} file 
 * @param {number} maxWidth 
 * @param {number} maxHeight 
 * @param {number} quality 
 * @returns {Promise<string>} Base64 Data URL
 */
export function compressImageToBase64(file, maxWidth = 320, maxHeight = 320, quality = 0.75) {
    return new Promise((resolve, reject) => {
        if (!file || !(file instanceof Blob)) {
            return reject(new Error('Invalid image file provided.'));
        }

        const reader = new FileReader();
        reader.onerror = (err) => reject(err);
        reader.onload = (e) => {
            const img = new Image();
            img.onerror = (err) => reject(err);
            img.onload = () => {
                let width = img.width;
                let height = img.height;

                if (width > height) {
                    if (width > maxWidth) {
                        height = Math.round((height * maxWidth) / width);
                        width = maxWidth;
                    }
                } else {
                    if (height > maxHeight) {
                        width = Math.round((width * maxHeight) / height);
                        height = maxHeight;
                    }
                }

                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;

                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);

                const dataUrl = canvas.toDataURL('image/jpeg', quality);
                resolve(dataUrl);
            };
            img.src = e.target.result;
        };
        reader.readAsDataURL(file);
    });
}export const DEFAULT_AVATAR_DATA_URI = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%2394a3b8'%3E%3Cpath d='M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z'/%3E%3C/svg%3E";

/**
 * Handles image loading errors gracefully by substituting a fallback avatar
 * or cleanly hiding the element to avoid showing a broken browser image icon.
 * 
 * @param {Event} e - The image onError event
 * @param {string|null} fallback - Optional fallback image URL / data URI
 */
export function handleImageError(e, fallback = DEFAULT_AVATAR_DATA_URI) {
    if (e?.target) {
        e.target.onerror = null; // Prevent infinite error loops
        if (fallback) {
            e.target.src = fallback;
        } else {
            e.target.style.display = 'none';
        }
    }
}
