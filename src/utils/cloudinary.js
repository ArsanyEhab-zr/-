import { 
    compressImageToBase64, 
    cropAndNormalizeAvatar, 
    getAvatarUrl, 
    getRawCloudinaryUrl,
    ensureExcelSafeImage, 
    sanitizeExcelRow, 
    repairAllExistingImages 
} from './imageUtils';

export { 
    compressImageToBase64, 
    cropAndNormalizeAvatar, 
    getAvatarUrl, 
    getRawCloudinaryUrl,
    ensureExcelSafeImage, 
    sanitizeExcelRow, 
    repairAllExistingImages 
};

/**
 * Uploads an image to Cloudinary with an aggressive 1:1 face-cropped Base64 offline-first fallback.
 * 
 * 1. Always crops & normalizes image first to a 1:1 face-centered square (< 30,000 chars).
 * 2. If offline, immediately returns the compressed 1:1 Base64 Data URI without throwing.
 * 3. Tries uploading to Cloudinary with an 8s timeout.
 * 4. Injects face-centering AI transformations (c_thumb,g_face,w_400,h_400) onto the returned URL.
 * 5. If Cloudinary fails or times out, immediately falls back to the compressed 1:1 Base64 Data URI.
 * 6. Strictly enforces https:// on all returned URLs.
 * 
 * @param {File|Blob|string} file - The file, blob, or data URL to upload
 * @param {string} resourceType - 'auto' | 'image' | 'raw'
 * @returns {Promise<string>} The Cloudinary secure_url or compressed 1:1 Base64 Data URI
 */
export const uploadImageToCloudinary = async (file, resourceType = 'auto') => {
    const isRawFile = resourceType === 'raw' || (file instanceof File && !file.type?.startsWith('image/'));

    let base64Fallback = null;
    let fileToUpload = file;

    // 1. Aggressively crop and normalize to 1:1 square face-centered image first (400x400, length <= 30000)
    if (!isRawFile) {
        try {
            base64Fallback = await compressImageToBase64(file, 400, 400, 0.65, 'image/webp');
            // Cloudinary's upload API natively accepts Base64 Data URI strings in the file parameter!
            fileToUpload = base64Fallback;
        } catch (compErr) {
            console.warn('⚠️ [Cloudinary] Image pre-compression warning:', compErr?.message);
        }
    }

    // 2. Offline check: immediately return compressed 1:1 Base64 without blocking the user
    if (!navigator.onLine) {
        console.log('ℹ️ [Cloudinary] Device is offline. Using local 1:1 Base64 image fallback.');
        if (base64Fallback) return base64Fallback;
        throw new Error('لا يوجد اتصال بالإنترنت');
    }

    const cloudName = import.meta.env.VITE_CLOUDINARY_CLOUD_NAME;
    const uploadPreset = import.meta.env.VITE_CLOUDINARY_UPLOAD_PRESET;

    if (!cloudName || !uploadPreset) {
        console.warn('⚠️ [Cloudinary] Credentials missing in .env. Falling back to compressed Base64.');
        if (base64Fallback) return base64Fallback;
        throw new Error('Cloudinary credentials are not configured in .env');
    }

    const formData = new FormData();
    formData.append('file', fileToUpload);
    formData.append('upload_preset', uploadPreset);

    // 3. Try uploading to Cloudinary with an 8-second timeout for weak networks
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);

        const response = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/${resourceType}/upload`, {
            method: 'POST',
            body: formData,
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (!response.ok) {
            throw new Error(`Cloudinary responded with status: ${response.status}`);
        }

        const data = await response.json();
        const rawUrl = data.secure_url || data.url;
        if (!rawUrl) throw new Error('Cloudinary response missing URL');

        // Strictly enforce https:// to prevent Mixed Content blocks and apply face-centering URL transform
        const secureUrl = rawUrl.replace(/^http:\/\//i, 'https://');
        return isRawFile ? secureUrl : getAvatarUrl(secureUrl);

    } catch (error) {
        console.warn('⚠️ [Cloudinary] Upload failed/timed out, seamlessly falling back to Base64:', error?.message);

        // Crucial: Return compressed 1:1 Base64 without throwing or blocking user
        if (base64Fallback) {
            return base64Fallback;
        }

        // For raw non-image documents (e.g. PDF curriculum upload), re-throw so admin is notified
        throw error;
    }
};
