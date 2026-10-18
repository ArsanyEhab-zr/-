/**
 * Normalizes Arabic names to handle spelling variations, diacritics, and whitespace.
 * e.g., '  مِينا  أحمد ' => 'مينا احمد'
 * 
 * @param {string} name
 * @returns {string}
 */
export function normalizeArabicName(name) {
    if (!name || typeof name !== 'string') return '';
    return name
        .trim()
        .toLowerCase()
        // Remove Arabic diacritics (tashkeel: fatha, damma, kasra, sukun, shadda, tanween)
        .replace(/[\u064B-\u065F\u0670]/g, '')
        // Normalize alef variants: أ, إ, آ, ٱ -> ا
        .replace(/[أإآٱ]/g, 'ا')
        // Normalize teh marbuta: ة -> ه
        .replace(/ة/g, 'ه')
        // Normalize yaa variants: ى, ئ -> ي
        .replace(/[ىئ]/g, 'ي')
        // Normalize multiple spaces into single space
        .replace(/\s+/g, ' ');
}

/**
 * Builds a composite unique key for duplicate detection based on class + normalized name.
 * 
 * @param {string} syncKey
 * @param {string} name
 * @returns {string}
 */
export function buildClassChildNameKey(syncKey, name) {
    const sKey = String(syncKey || '').trim().toLowerCase();
    const nName = normalizeArabicName(name);
    return `${sKey}___${nName}`;
}
