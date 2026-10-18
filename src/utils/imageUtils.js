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
}
